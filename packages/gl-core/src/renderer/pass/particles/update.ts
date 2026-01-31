import type { Renderer, Texture } from '@sakitam-gis/vis-engine';
import { BlendType, Geometry, Mesh, Program, RenderTarget, utils, Vector2 } from '@sakitam-gis/vis-engine';
import Pass from '../base';
import { littleEndian } from '../../../utils/common';
import vert from '../../../shaders/particles/update.vert.glsl';
import frag from '../../../shaders/particles/update.frag.glsl';
import * as shaderLib from '../../../shaders/shaderLib';
import type { BandType } from '../../../type';
import type { SourceType } from '../../../source';

export interface UpdatePassOptions {
  source: SourceType;
  texture: Texture;
  textureNext: Texture;
  bandType: BandType;
  getParticleNumber: () => number;
  glScale: number;
}

export default class UpdatePass extends Pass<UpdatePassOptions> {
  readonly prerender = true;

  #program: WithNull<Program>;
  #mesh: WithNull<Mesh>;
  #geometry: WithNull<Geometry>;
  #current: WithNull<RenderTarget>;
  #next: WithNull<RenderTarget>;

  #initialize = true;

  #particleRes: number;

  constructor(id: string, renderer: Renderer, options: UpdatePassOptions = {} as UpdatePassOptions) {
    super(id, renderer, options);

    this.initializeRenderTarget();

    this.#program = new Program(renderer, {
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        u_fade_t: {
          value: 0,
        },
        displayRange: {
          value: new Vector2(-Infinity, Infinity),
        },
        u_texture: {
          value: this.options.texture,
        },
        u_textureNext: {
          value: this.options.textureNext,
        },
        u_particles: {
          value: null,
        },
      },
      defines: [`RENDER_TYPE ${this.options.bandType}`, `LITTLE_ENDIAN ${littleEndian}`],
      includes: shaderLib,
      blending: BlendType.NoBlending,
      transparent: true,
    });

    this.#geometry = new Geometry(renderer, {
      position: {
        size: 2,
        data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      },
      uv: {
        size: 2,
        data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      },
      index: {
        size: 1,
        data: new Uint16Array([0, 1, 2, 2, 1, 3]),
      },
    });

    this.#mesh = new Mesh(renderer, {
      mode: renderer.gl.TRIANGLES,
      program: this.#program,
      geometry: this.#geometry,
    });
  }

  #getParticleRes() {
    return Math.ceil(Math.sqrt(this.options.getParticleNumber()));
  }

  resize() {
    const particleRes = this.#getParticleRes();

    this.#current?.resize(particleRes, particleRes);
    this.#next?.resize(particleRes, particleRes);
  }

  get textures() {
    return {
      currentParticles: this.#current?.texture,
      nextParticles: this.#next?.texture,
    };
  }

  setInitialize(state: boolean) {
    this.#initialize = state;
  }

  /**
   * 创建 RenderTarget
   */
  initializeRenderTarget() {
    const particleRes = this.#getParticleRes();

    const particleState = new Float32Array(particleRes ** 2 * 4);
    const s = this.options.glScale;
    for (let i = 0; i < particleState.length; i++) {
      // 不同地图初始化的实际投影位置是不同的，但是这里只能归一化到 0-1（gl），需要在着色器中反算
      particleState[i] = Math.random() * s;
    }

    // @link https://webgl2fundamentals.org/webgl/lessons/webgl-data-textures.html
    const opt = {
      data: particleState,
      width: particleRes,
      height: particleRes,
      minFilter: this.renderer.gl.NEAREST,
      magFilter: this.renderer.gl.NEAREST,
      type: this.renderer.gl.FLOAT,
      format: this.renderer.gl.RGBA,
      internalFormat: this.renderer.isWebGL2
        ? (this.renderer.gl as WebGL2RenderingContext).RGBA32F
        : this.renderer.gl.RGBA,
      stencil: false,
    };

    this.#current = new RenderTarget(this.renderer, {
      ...opt,
      name: 'currentUpdateTexture',
    });
    this.#next = new RenderTarget(this.renderer, {
      ...opt,
      name: 'nextUpdateTexture',
    });
  }

  /**
   * 交换 RenderTarget
   */
  swapRenderTarget() {
    [this.#current, this.#next] = [this.#next, this.#current];
  }

  /**
   * @param rendererParams
   * @param rendererState
   */
  render(rendererParams, rendererState) {
    const attr = this.renderer.attributes;
    const camera = rendererParams.cameras.planeCamera;
    const particleRes = this.#getParticleRes();
    if (!this.#particleRes || this.#particleRes !== particleRes) {
      this.#particleRes = particleRes;
      this.initializeRenderTarget();
    }

    if (this.#next) {
      this.#next.bind();
      if (attr.depth && this.#next.depth) {
        this.renderer.state.enable(this.renderer.gl.DEPTH_TEST);
        this.renderer.state.setDepthMask(true);
      }
      this.renderer.setViewport(this.#next.width, this.#next.height);
    }
    if (rendererState && this.#mesh) {
      const uniforms = utils.pick(rendererState, [
        'dataRange',
        'useDisplayRange',
        'displayRange',
        'u_drop_rate',
        'u_drop_rate_bump',
        'u_max_age',
        'u_min_lifespan_percent',
        'u_speed_factor',
        'u_flip_y',
        'u_gl_scale',
      ]);

      Object.keys(uniforms).forEach((key) => {
        if (uniforms[key] !== undefined) {
          this.#mesh?.program.setUniform(key, uniforms[key]);
        }
      });

      const fade = this.options.source?.getFadeTime?.() || 0;
      this.#mesh.program.setUniform(
        'u_image_res',
        new Vector2(this.options.texture.width, this.options.texture.height),
      );
      this.#mesh.program.setUniform('u_fade_t', fade);
      this.#mesh.program.setUniform('u_rand_seed', Math.random());
      this.#mesh.program.setUniform('u_particles', this.#current?.texture);

      // Phase 5 Exp I: force velocity override
      const forceVelocity = typeof window !== 'undefined' ? ((window as any).__PARTICLE_FORCE_VELOCITY__ || 0.0) : 0.0;
      this.#mesh.program.setUniform('u_force_velocity', forceVelocity);
      // Phase 4 Experiment B: optionally override bbox with a fixed low-zoom bbox
      const forceBbox = typeof window !== 'undefined' && (window as any).__PARTICLE_FORCE_BBOX__;
      this.#mesh.program.setUniform('u_bbox', forceBbox || rendererState.extent);
      this.#mesh.program.setUniform('u_initialize', this.#initialize);
      this.#mesh.program.setUniform('u_data_bbox', rendererState.sharedState.u_data_bbox);

      this.#mesh.updateMatrix();
      this.#mesh.worldMatrixNeedsUpdate = false;
      this.#mesh.worldMatrix.multiply(camera.worldMatrix, this.#mesh.localMatrix);
      this.#mesh.draw({
        ...rendererParams,
        camera,
      });
    }
    if (this.#next) {
      this.#next.unbind();
    }

    this.#initialize = false;

    this.swapRenderTarget();

    // Phase 4 Experiment A: readback particle state after update to verify positions
    if (typeof window !== 'undefined' && (window as any).__PARTICLE_DEBUG__) {
      const zoom = rendererState?.zoom ?? 0;
      const roundedZoom = Math.round(zoom * 2) / 2;
      const lastZoom = (this as any).__lastLoggedUpdateZoom;
      if (lastZoom !== roundedZoom) {
        (this as any).__lastLoggedUpdateZoom = roundedZoom;
        const gl = this.renderer.gl as WebGL2RenderingContext;
        const curTex = this.#current?.texture;
        if (curTex) {
          try {
            const readFbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curTex.handle, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
              const w = curTex.width || 1;
              const samplePositions = [
                [0, 0], [Math.floor(w / 4), Math.floor(w / 4)],
                [Math.floor(w / 2), Math.floor(w / 2)], [w - 1, w - 1],
              ];
              const samples: Record<string, string> = {};
              for (const [sx, sy] of samplePositions) {
                const px = new Float32Array(4);
                gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.FLOAT, px);
                samples[`p[${sx},${sy}]`] = `(${px[0].toFixed(4)}, ${px[1].toFixed(4)}, age=${px[2].toFixed(1)})`;
              }
              // eslint-disable-next-line no-console
              console.info('[Phase4-Update] post-swap readback', {
                zoom: roundedZoom,
                texSize: `${w}x${curTex.height}`,
                u_bbox: rendererState?.extent ? Array.from(rendererState.extent).map((v: number) => v.toFixed(6)) : null,
                ...samples,
              });
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(readFbo);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[Phase4-Update] readback failed:', e);
          }
          this.renderer.resetState?.();
        }
      }
    }

    // Phase 5 Experiment J: Frame-to-frame particle position diff
    // Captures particle positions on consecutive frames and logs the delta.
    // Triggered by window.__PARTICLE_EXP_J__ = true; logs 5 frame-pairs then stops.
    if (typeof window !== 'undefined' && (window as any).__PARTICLE_EXP_J__) {
      const jState = ((this as any).__expJ = (this as any).__expJ || { count: 0, prev: null });
      if (jState.count < 5) {
        const gl = this.renderer.gl as WebGL2RenderingContext;
        const curTex = this.#current?.texture;
        if (curTex) {
          try {
            const w = curTex.width || 1;
            const numSamples = 8;
            const currentData = new Float32Array(numSamples * 4);
            const readFbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curTex.handle, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
              // Read 8 fixed particle positions
              const positions = [
                [0, 0], [1, 0], [2, 0], [3, 0],
                [0, 1], [Math.floor(w / 2), 0], [0, Math.floor(w / 2)], [Math.floor(w / 2), Math.floor(w / 2)],
              ];
              for (let i = 0; i < positions.length; i++) {
                const px = new Float32Array(4);
                gl.readPixels(positions[i][0], positions[i][1], 1, 1, gl.RGBA, gl.FLOAT, px);
                currentData.set(px, i * 4);
              }

              if (jState.prev) {
                // Compare with previous frame
                const diffs: Record<string, string> = {};
                let totalDelta = 0;
                let movedCount = 0;
                for (let i = 0; i < positions.length; i++) {
                  const [px, py] = positions[i];
                  const prevX = jState.prev[i * 4];
                  const prevY = jState.prev[i * 4 + 1];
                  const prevAge = jState.prev[i * 4 + 2];
                  const curX = currentData[i * 4];
                  const curY = currentData[i * 4 + 1];
                  const curAge = currentData[i * 4 + 2];
                  const dx = curX - prevX;
                  const dy = curY - prevY;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  totalDelta += dist;
                  if (dist > 0.000001) movedCount++;
                  diffs[`p[${px},${py}]`] = `dx=${dx.toFixed(8)} dy=${dy.toFixed(8)} d=${dist.toFixed(8)} age:${prevAge.toFixed(0)}->${curAge.toFixed(0)}`;
                }
                // eslint-disable-next-line no-console
                console.info(`[Phase5-ExpJ] frame-diff #${jState.count}`, {
                  zoom: Math.round((rendererState?.zoom ?? 0) * 2) / 2,
                  movedParticles: `${movedCount}/${positions.length}`,
                  totalDelta: totalDelta.toFixed(8),
                  u_speed_factor: rendererState?.u_speed_factor,
                  u_gl_scale: rendererState?.u_gl_scale,
                  ...diffs,
                });
                jState.count++;
              }
              jState.prev = new Float32Array(currentData);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(readFbo);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[Phase5-ExpJ] readback failed:', e);
          }
          this.renderer.resetState?.();
        }
      } else if (jState.count === 5) {
        jState.count++;
        // eslint-disable-next-line no-console
        console.info('[Phase5-ExpJ] Done — 5 frame-pairs captured. Set window.__PARTICLE_EXP_J__ = false then true to re-run.');
      }
    } else {
      // Reset when toggled off
      (this as any).__expJ = null;
    }

    // Phase 5 Experiment L: FBO precision verification
    // Tests whether RGBA32F FBOs actually store float32 values when RENDERED to.
    // Runs once, triggered by window.__PARTICLE_EXP_L__ = true
    if (typeof window !== 'undefined' && (window as any).__PARTICLE_EXP_L__ && !(this as any).__expLDone) {
      (this as any).__expLDone = true;
      const gl = this.renderer.gl as WebGL2RenderingContext;
      const curTex = this.#current?.texture;
      try {
        const typeNames: Record<number, string> = {
          [gl.FLOAT]: 'FLOAT', [gl.HALF_FLOAT]: 'HALF_FLOAT', [gl.UNSIGNED_BYTE]: 'UNSIGNED_BYTE',
          [gl.UNSIGNED_SHORT_5_6_5]: 'UNSIGNED_SHORT_5_6_5', [gl.UNSIGNED_SHORT_4_4_4_4]: 'UNSIGNED_SHORT_4_4_4_4',
        };
        const fmtNames: Record<number, string> = {
          [gl.RGBA]: 'RGBA', [gl.RGB]: 'RGB',
          [gl.RGBA32F]: 'RGBA32F', [gl.RGBA16F]: 'RGBA16F',
          [gl.RGBA8]: 'RGBA8', [gl.R32F]: 'R32F', [gl.RG32F]: 'RG32F',
        };
        const resolve = (map: Record<number, string>, v: number) => map[v] || `0x${v.toString(16)}`;

        // 1. Query ACTUAL internal format of the update FBO texture
        if (curTex) {
          const fboCheck = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fboCheck);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curTex.handle, 0);
          const fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

          // Query the FBO attachment's actual internal format
          let attachInternalFormat = 0;
          let attachColorEncoding = 0;
          let attachComponentType = 0;
          if (fboStatus === gl.FRAMEBUFFER_COMPLETE) {
            attachInternalFormat = gl.getFramebufferAttachmentParameter(
              gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING);
            attachComponentType = gl.getFramebufferAttachmentParameter(
              gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
            // RED/GREEN/BLUE/ALPHA sizes tell us the actual bit depth
            const rSize = gl.getFramebufferAttachmentParameter(
              gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE);
            const gSize = gl.getFramebufferAttachmentParameter(
              gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE);
            const bSize = gl.getFramebufferAttachmentParameter(
              gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE);
            const aSize = gl.getFramebufferAttachmentParameter(
              gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE);
            // implColorReadType when this FBO is bound
            const implType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
            const implFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);

            // eslint-disable-next-line no-console
            console.info('[Phase5-ExpL] Update FBO attachment info', {
              texSize: `${curTex.width}x${curTex.height}`,
              fboComplete: true,
              channelBits: `R=${rSize} G=${gSize} B=${bSize} A=${aSize}`,
              expectedBits: 'RGBA32F=32/32/32/32, RGBA16F=16/16/16/16',
              componentType: attachComponentType === gl.FLOAT ? 'FLOAT' : `0x${attachComponentType.toString(16)}`,
              implReadType: resolve(typeNames, implType),
              implReadFormat: resolve(fmtNames, implFormat),
            });
          } else {
            // eslint-disable-next-line no-console
            console.warn('[Phase5-ExpL] Update FBO incomplete!');
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(fboCheck);

          // 2. Read back actual particle positions with full precision
          const readFbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curTex.handle, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
            const w = curTex.width || 1;
            const positions = [[0, 0], [1, 0], [0, 1], [Math.floor(w / 2), Math.floor(w / 2)]];
            const samples: Record<string, string> = {};
            for (const [sx, sy] of positions) {
              const px = new Float32Array(4);
              gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.FLOAT, px);
              samples[`p[${sx},${sy}]`] = `x=${px[0].toPrecision(10)} y=${px[1].toPrecision(10)} age=${px[2].toPrecision(10)}`;
            }
            // eslint-disable-next-line no-console
            console.info('[Phase5-ExpL] Particle positions (full precision)', samples);
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(readFbo);
        }

        // 3. RGBA32F upload-only test (no rendering)
        const testData = new Float32Array([0.123456789, 0.987654321, 42.1234567, 1.0]);
        const testTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, testTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, testData);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const testFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, testFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, testTex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
          const rb = new Float32Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, rb);
          // eslint-disable-next-line no-console
          console.info('[Phase5-ExpL] RGBA32F upload test', {
            wrote: Array.from(testData).map(v => v.toPrecision(10)),
            readBack: Array.from(rb).map(v => v.toPrecision(10)),
            fullPrecision: testData.every((v, i) => Math.abs(v - rb[i]) < 1e-6),
          });
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // 4. RGBA32F RENDER test — draw a shader that outputs known fp32 values
        // This tests whether fragment shader output to RGBA32F FBO maintains precision
        const renderVs = `#version 300 es
          in vec2 pos;
          void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;
        const renderFs = `#version 300 es
          precision highp float;
          out vec4 fragColor;
          void main() {
            // Output values that are distinguishable in fp32 but NOT in fp16
            // 0.300012345 in fp16 rounds to 0.30004883 (step=0.000244)
            // 0.300012345 in fp32 is exact to ~7 digits
            fragColor = vec4(0.300012345, 0.400023456, 50.1234567, 1.0);
          }`;
        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, renderVs);
        gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, renderFs);
        gl.compileShader(fs);
        const prog = gl.createProgram()!;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);

        if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          // Render to RGBA32F FBO
          gl.bindFramebuffer(gl.FRAMEBUFFER, testFbo);
          gl.viewport(0, 0, 1, 1);
          gl.useProgram(prog);
          const vao = gl.createVertexArray();
          gl.bindVertexArray(vao);
          const buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
          const posLoc = gl.getAttribLocation(prog, 'pos');
          gl.enableVertexAttribArray(posLoc);
          gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          const rendered32 = new Float32Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, rendered32);
          // eslint-disable-next-line no-console
          console.info('[Phase5-ExpL] RGBA32F RENDER test', {
            expected: '0.300012345, 0.400023456, 50.1234567, 1.0',
            readBack: Array.from(rendered32).map(v => v.toPrecision(10)),
            fullPrecision: Math.abs(rendered32[0] - 0.300012345) < 1e-6,
            error_R: Math.abs(rendered32[0] - 0.300012345).toExponential(3),
            error_G: Math.abs(rendered32[1] - 0.400023456).toExponential(3),
          });

          // Also render to RGBA16F FBO for comparison
          const tex16 = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex16);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          const fbo16 = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo16);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex16, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const rendered16 = new Float32Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, rendered16);
            // eslint-disable-next-line no-console
            console.info('[Phase5-ExpL] RGBA16F RENDER test (comparison)', {
              expected: '0.300012345, 0.400023456, 50.1234567, 1.0',
              readBack: Array.from(rendered16).map(v => v.toPrecision(10)),
              error_R: Math.abs(rendered16[0] - 0.300012345).toExponential(3),
              error_G: Math.abs(rendered16[1] - 0.400023456).toExponential(3),
            });
          }

          // Compare particle positions against the RGBA16F rendered output
          // If the particle positions match RGBA16F precision, the update FBO is secretly fp16
          // eslint-disable-next-line no-console
          console.info('[Phase5-ExpL] CONCLUSION', {
            note: 'If particle positions show x=0.3000488281 (fp16 quantized) but RGBA32F RENDER test shows 0.3000123501 (full precision), the vis-engine RenderTarget is creating RGBA16F despite requesting RGBA32F.',
          });

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(fbo16);
          gl.deleteTexture(tex16);
          gl.deleteBuffer(buf);
          gl.deleteVertexArray(vao);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(testFbo);
        gl.deleteTexture(testTex);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteProgram(prog);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Phase5-ExpL] precision test failed:', e);
      }
      this.renderer.resetState?.();
    } else if (typeof window !== 'undefined' && !(window as any).__PARTICLE_EXP_L__) {
      (this as any).__expLDone = false;
    }
  }

  destroy() {
    if (this.#mesh) {
      this.#mesh.destroy();
      this.#mesh = null;
    }

    if (this.#program) {
      this.#program.destroy();
      this.#program = null;
    }

    if (this.#geometry) {
      this.#geometry.destroy();
      this.#geometry = null;
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
