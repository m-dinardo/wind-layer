import type { Renderer } from '@sakitam-gis/vis-engine';
import { Program, RenderTarget } from '@sakitam-gis/vis-engine';
import Pass from '../base';
import vert from '../../../shaders/common.vert.glsl';
import frag from '../../../shaders/compose.frag.glsl';
import * as shaderLib from '../../../shaders/shaderLib';
import type { RenderFrom, BandType } from '../../../type';
import { littleEndian } from '../../../utils/common';
import type TileID from '../../../tile/TileID';
import type { SourceType } from '../../../source';

export interface ParticlesComposePassOptions {
  id: string;
  source: SourceType;
  bandType: BandType;
  renderFrom: RenderFrom;
  stencilConfigForOverlap: (tiles: any[]) => [{ [_: number]: any }, TileID[]];
  getTileProjSize: (z: number, tiles: TileID[]) => [number, number];
  allowFloatBlend?: boolean;
  targetType?: {
    type: number;
    internalFormat: number;
    allowBlend: boolean;
    label?: string;
  };
}

const defaultSize = 256;

/**
 * 按区域加载视图范围内的瓦片，然后合并单张纹理
 */
export default class ParticlesComposePass extends Pass<ParticlesComposePassOptions> {
  readonly prerender = true;

  #program: WithNull<Program>;
  #current: WithNull<RenderTarget>;
  #next: WithNull<RenderTarget>;
  #uid: string;
  #loggedDisableBlend = false;
  #usesFloat: boolean;
  #targetType: NonNullable<ParticlesComposePassOptions['targetType']>;

  #width = defaultSize;
  #height = defaultSize;

  constructor(
    id: string,
    renderer: Renderer,
    options: ParticlesComposePassOptions = {} as ParticlesComposePassOptions,
  ) {
    super(id, renderer, options);

    this.#uid = options.id;
    this.#targetType =
      options.targetType ||
      ({
        type: this.renderer.gl.FLOAT,
        internalFormat: this.renderer.isWebGL2
          ? (this.renderer.gl as WebGL2RenderingContext).RGBA32F
          : this.renderer.gl.RGBA,
        allowBlend: options.allowFloatBlend !== false,
        label: 'float',
      } as const);
    this.#usesFloat = this.#targetType.type === this.renderer.gl.FLOAT;

    this.#program = new Program(renderer, {
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        u_image0: {
          value: undefined,
        },
        dataRange: {
          value: undefined,
        },
      },
      defines: [`RENDER_TYPE ${this.options.bandType}`, `LITTLE_ENDIAN ${littleEndian}`],
      includes: shaderLib,
    });

    // @link https://webgl2fundamentals.org/webgl/lessons/webgl-data-textures.html
    const opt = {
      width: this.#width,
      height: this.#height,
      minFilter: renderer.gl.NEAREST,
      magFilter: renderer.gl.NEAREST,
      type: this.#targetType.type,
      format: this.renderer.gl.RGBA,
      internalFormat: this.#targetType.internalFormat,
      stencil: true,
    };

    this.#current = new RenderTarget(renderer, {
      ...opt,
      name: 'currentRenderTargetTexture',
    });
    this.#next = new RenderTarget(renderer, {
      ...opt,
      name: 'nextRenderTargetTexture',
    });
  }

  resize(width: number, height: number) {
    if (width !== this.#width || height !== this.#height) {
      this.#current?.resize(width, height);
      this.#next?.resize(width, height);
      this.#width = width;
      this.#height = height;
    }
  }

  get textures() {
    return {
      current: this.#current?.texture,
      next: this.#next?.texture,
    };
  }

  renderTexture(renderTarget, rendererParams, rendererState, sourceCache) {
    if (!sourceCache) {
      return;
    }

    const { stencilConfigForOverlap } = this.options;
    const camera = rendererParams.cameras.planeCamera;
    const coordsAscending = sourceCache.getVisibleCoordinates();
    const coordsDescending = coordsAscending.slice().reverse(); // offscreen & opaque

    if (!coordsDescending.length) return;

    let xmin = Infinity;
    let ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    let zmin = Infinity;
    let zmax = -Infinity;
    // 1. 计算mapbox墨卡托坐标的最大最小值，构建真实瓦片范围
    // 注意这里不要直接使用图层计算的原始瓦片范围，因为在加载过程中有可能会有失败，我
    // 们应该取真实加载后的瓦片计算范围
    // mapbox 的坐标原点是左上角
    for (let n = 0; n < coordsDescending.length; n++) {
      const tileId = coordsDescending[n];
      const bounds = tileId.getTileProjBounds();
      // @todo 不同引擎的top 和 bottom 方向可能不一样
      xmin = Math.min(bounds.left, xmin);
      xmax = Math.max(bounds.right, xmax);
      zmin = Math.min(tileId.z, zmin);
      zmax = Math.max(tileId.z, zmax);

      if (!rendererState.u_flip_y) {
        ymin = Math.min(bounds.top, ymin);
        ymax = Math.max(bounds.bottom, ymax);
      } else {
        ymin = Math.min(bounds.bottom, ymin);
        ymax = Math.max(bounds.top, ymax);
      }
    }

    const zz = this.options.getTileProjSize(zmax, coordsDescending);

    const dx = xmax - xmin;
    const dy = ymax - ymin;

    // 2. 计算 x 方向和 y 方向的行列数
    const w = dx / zz[0];
    const h = dy / zz[1];

    // TODO: 瓦片范围和行列数是否可以提到瓦片计算的时候获取，可以减少几次循环

    rendererState.sharedState.u_data_bbox = [xmin, ymin, xmax, ymax];
    rendererState.sharedState.u_data_zooms = [zmin, zmax];

    // Phase 4 Experiment A: log compose pass state per zoom
    if (typeof window !== 'undefined' && (window as any).__PARTICLE_DEBUG__) {
      const roundedZoom = Math.round((rendererState.zoom ?? 0) * 2) / 2;
      const lastZoom = (this as any).__lastLoggedComposeZoom;
      if (lastZoom !== roundedZoom) {
        (this as any).__lastLoggedComposeZoom = roundedZoom;
        // eslint-disable-next-line no-console
        console.info('[Phase4-Compose]', {
          zoom: roundedZoom,
          tileCount: coordsDescending.length,
          tileZoomRange: [zmin, zmax],
          u_data_bbox: [xmin.toFixed(6), ymin.toFixed(6), xmax.toFixed(6), ymax.toFixed(6)],
          dataBboxSize: [(xmax - xmin).toFixed(6), (ymax - ymin).toFixed(6)],
          tileGridSize: [w.toFixed(2), h.toFixed(2)],
        });
      }
    }

    if (renderTarget) {
      renderTarget.clear();
      renderTarget.bind();
      if (this.#targetType.allowBlend === false) {
        this.renderer.state.disable(this.renderer.gl.BLEND);
        if (!this.#loggedDisableBlend) {
          // eslint-disable-next-line no-console
          console.info('[wind-gl-core] particles compose: disabling blend (EXT_float_blend unavailable)', {
            target: this.#targetType.label,
          });
          this.#loggedDisableBlend = true;
        }
      }
      const attr = this.renderer.attributes;
      if (attr.depth && renderTarget.depth) {
        this.renderer.state.enable(this.renderer.gl.DEPTH_TEST);
        this.renderer.state.setDepthMask(true);
      }

      // 3. 计算出 fbo 所需大小 (此处有可能计算的宽高超出纹理最大大小，我们需要根据宽高比例进行重采样)
      let width = w * (this.options.source.tileSize ?? defaultSize);
      let height = h * (this.options.source.tileSize ?? defaultSize);

      rendererState.sharedState.u_tiles_size = [width, height];

      const maxTextureSize = this.renderer.gl.getParameter(this.renderer.gl.MAX_TEXTURE_SIZE) * 0.5;
      const maxRenderBufferSize = this.renderer.gl.getParameter(this.renderer.gl.MAX_RENDERBUFFER_SIZE) * 0.5;
      const maxSize = Math.max(width, height);
      if (maxSize > maxTextureSize) {
        width = (maxTextureSize / maxSize) * width;
        height = (maxTextureSize / maxSize) * height;
      } else if (maxSize > maxRenderBufferSize) {
        width = (maxRenderBufferSize / maxSize) * width;
        height = (maxRenderBufferSize / maxSize) * height;
      }

      this.resize(width, height);

      this.renderer.setViewport(width, height);
    }

    const [stencilModes, coords] = stencilConfigForOverlap(coordsDescending);

    // 4. 循环 TileID，从 sourceCache 查找对应瓦片渲染（默认是从视野中心向两边渲染）
    for (let k = 0; k < coords.length; k++) {
      const coord = coords[k];
      // 5. 进行渲染
      if (coord) {
        const tile = sourceCache.getTile(coord);
        if (!(tile && tile.hasData())) continue;

        const tileBBox = coord.getTileProjBounds();
        if (!tileBBox) continue;

        const tileMesh = tile.createMesh(this.#uid, tileBBox, this.renderer, this.#program);
        const mesh = tileMesh.planeMesh;

        const scale = Math.pow(2, zmax - coord.z);
        mesh.scale.set((1 / w) * scale, (1 / h) * scale, 1);
        if (!rendererState.u_flip_y) {
          mesh.position.set((tileBBox.left - xmin) / dx, (tileBBox.top - ymin) / dy, 0);
        } else {
          mesh.position.set((tileBBox.left - xmin) / dx, 1 - (tileBBox.top - ymin) / dy, 0);
        }

        const dataRange: number[] = [];
        for (const [index, texture] of tile.textures) {
          if (texture.userData?.dataRange && Array.isArray(texture.userData?.dataRange)) {
            dataRange.push(...texture.userData.dataRange);
          }
          mesh.program.setUniform(`u_image${index}`, texture);
        }

        if (dataRange.length > 0) {
          mesh.program.setUniform('dataRange', dataRange);
        }

        mesh.updateMatrix();
        mesh.worldMatrixNeedsUpdate = false;
        mesh.worldMatrix.multiply(camera.worldMatrix, mesh.localMatrix);

        const stencilMode = stencilModes[coord.overscaledZ];

        if (stencilMode) {
          if (stencilMode.stencil) {
            this.renderer.state.enable(this.renderer.gl.STENCIL_TEST);

            this.renderer.state.setStencilFunc(stencilMode.func?.cmp, stencilMode.func?.ref, stencilMode.func?.mask);
            this.renderer.state.setStencilOp(stencilMode.op?.fail, stencilMode.op?.zfail, stencilMode.op?.zpass);
          } else {
            this.renderer.state.disable(this.renderer.gl.STENCIL_TEST);
          }
        }

        mesh.draw({
          ...rendererParams,
          camera,
        });
      }
    }

    if (renderTarget) {
      renderTarget.unbind();
    }
  }

  /**
   * 此处绘制主要是合并瓦片
   * @param rendererParams
   * @param rendererState
   */
  render(rendererParams, rendererState) {
    const { source } = this.options;
    const sourceCache = source.sourceCache;
    if (Array.isArray(sourceCache)) {
      if (sourceCache.length === 2) {
        this.renderTexture(this.#current, rendererParams, rendererState, sourceCache[0]);
        this.renderTexture(this.#next, rendererParams, rendererState, sourceCache[1]);
      } else {
        this.renderTexture(this.#current, rendererParams, rendererState, sourceCache[0]);
        this.renderTexture(this.#next, rendererParams, rendererState, sourceCache[0]);
      }
    } else {
      this.renderTexture(this.#current, rendererParams, rendererState, sourceCache);
      this.renderTexture(this.#next, rendererParams, rendererState, sourceCache);
    }

    // Phase 4: Readback compose FBO to verify velocity data is present at all zoom levels
    if (typeof window !== 'undefined' && (window as any).__PARTICLE_DEBUG__ && this.#current?.texture) {
      const zoom = rendererState?.zoom ?? 0;
      const roundedZoom = Math.round(zoom * 2) / 2;
      const lastZoom = (this as any).__lastLoggedComposeReadbackZoom;
      if (lastZoom !== roundedZoom) {
        (this as any).__lastLoggedComposeReadbackZoom = roundedZoom;
        const gl = this.renderer.gl as WebGL2RenderingContext;
        const tex = this.#current.texture;
        try {
          const readFbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.handle, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
            const w = tex.width || 1;
            const h = tex.height || 1;
            // Sample 4 positions across the compose FBO
            const positions = [
              [Math.floor(w / 4), Math.floor(h / 4)],
              [Math.floor(w / 2), Math.floor(h / 2)],
              [Math.floor(w * 3 / 4), Math.floor(h * 3 / 4)],
              [Math.floor(w / 2), Math.floor(h / 4)],
            ];
            const samples: Record<string, string> = {};
            let nonZeroCount = 0;
            // Always use FLOAT for readPixels — works for both RGBA32F and RGBA16F targets.
            // Using UNSIGNED_BYTE on a half-float FBO silently returns zeros.
            for (const [sx, sy] of positions) {
              const px = new Float32Array(4);
              gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.FLOAT, px);
              const vals = Array.from(px);
              samples[`v[${sx},${sy}]`] = `(${vals[0].toFixed(4)}, ${vals[1].toFixed(4)}, a=${vals[3].toFixed(2)})`;
              if (Math.abs(vals[0]) > 0.001 || Math.abs(vals[1]) > 0.001) nonZeroCount++;
            }
            // eslint-disable-next-line no-console
            console.info('[Phase4-Compose] FBO readback', {
              zoom: roundedZoom,
              fboSize: `${w}x${h}`,
              targetLabel: this.#targetType.label,
              nonZeroSamples: `${nonZeroCount}/${positions.length}`,
              ...samples,
            });
          } else {
            // eslint-disable-next-line no-console
            console.warn('[Phase4-Compose] FBO readback: framebuffer incomplete');
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(readFbo);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Phase4-Compose] FBO readback failed:', e);
        }
        this.renderer.resetState?.();
      }
    }
  }

  destroy() {
    if (this.#program) {
      this.#program.destroy();
      this.#program = null;
    }

    if (this.#current) {
      this.#current.destroy();
      this.#current = null;
    }

    if (this.#next) {
      this.#next.destroy();
      this.#next = null;
    }
  }
}
