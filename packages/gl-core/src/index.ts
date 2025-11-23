import wgw from 'wind-gl-worker';
import BaseLayer, { defaultOptions } from './renderer';
import TileID from './tile/TileID';
import Tile from './tile/Tile';
import type { BaseLayerOptions, UserOptions } from './renderer';

const configDeps = wgw.configDeps;

export * from './utils/common';

export { BaseLayer, BaseLayerOptions, UserOptions, TileID, Tile, defaultOptions, configDeps };

export * from './source';

export * from './type';

// Build marker for QA to confirm forked gl-core is loaded at runtime (BF-72).
// eslint-disable-next-line no-console
console.info('[wind-gl-core] loaded fork build (BF-72 inline fallback)');
