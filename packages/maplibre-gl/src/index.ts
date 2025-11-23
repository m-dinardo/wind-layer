import {
  configDeps,
  TileID,
  ImageSource,
  TileSource,
  TimelineSource,
  RenderType,
  MaskType,
  RenderFrom,
  DecodeType,
  LayerSourceType,
} from 'wind-gl-core';
// Build marker to verify the fork is loaded at runtime (BF-72).
// eslint-disable-next-line no-console
console.info('[maplibre-wind] loaded fork build (BF-72 inline fallback)');
export { default as Layer } from './layer';
export {
  configDeps,
  TileID,
  ImageSource,
  TileSource,
  TimelineSource,
  RenderFrom,
  RenderType,
  MaskType,
  DecodeType,
  LayerSourceType,
};
