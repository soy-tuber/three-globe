// Terrain system: global displaced globe (via three-globe's globe layer) + regional hi-res patches.
import * as THREE from 'three';
import type ThreeGlobe from 'three-globe';
import { sampleRegion, type TerrainRegion } from './terrainData';
import { METRES_TO_UNITS, createTerrainMaterial, type TerrainUniforms } from './terrainShader';

const GLOBE_RADIUS = 100;
/** Degrees between patch mesh vertices. */
const PATCH_STEP_DEG = 0.03;
/** Degrees between global sphere vertices (three-globe globeCurvatureResolution). */
const GLOBE_STEP_DEG = 0.3;

/** three-globe's polar → cartesian convention (Y = north pole, lng 0 on +Z). */
export function polarToCartesian(lat: number, lng: number, r: number, out = new THREE.Vector3()) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  return out.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

function buildPatchGeometry(bbox: [number, number, number, number]): THREE.BufferGeometry {
  const [w, s, e, n] = bbox;
  const nx = Math.round((e - w) / PATCH_STEP_DEG);
  const ny = Math.round((n - s) / PATCH_STEP_DEG);
  // Interior grid plus a one-vertex skirt ring around it.
  const cols = nx + 3;
  const rows = ny + 3;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  const skirt = new Float32Array(cols * rows);
  const v = new THREE.Vector3();
  for (let j = 0; j < rows; j++) {
    const jj = Math.min(ny, Math.max(0, j - 1));
    const lat = s + (jj / ny) * (n - s);
    for (let i = 0; i < cols; i++) {
      const ii = Math.min(nx, Math.max(0, i - 1));
      const lng = w + (ii / nx) * (e - w);
      const k = j * cols + i;
      polarToCartesian(lat, lng, GLOBE_RADIUS, v).toArray(pos, k * 3);
      uv[k * 2] = (lng + 180) / 360;
      uv[k * 2 + 1] = (lat + 90) / 180;
      skirt[k] = i === 0 || j === 0 || i === cols - 1 || j === rows - 1 ? 1 : 0;
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let p = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      // Counter-clockwise when seen from outside the sphere.
      index[p++] = a; index[p++] = b; index[p++] = c;
      index[p++] = b; index[p++] = d; index[p++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skirt', new THREE.BufferAttribute(skirt, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

export class Terrain {
  readonly uniforms: TerrainUniforms = {
    uExag: { value: 6 },
    uSunDir: { value: new THREE.Vector3(1, 1, 1).normalize() },
    uRealSun: { value: 0 },
    uTime: { value: 0 },
    uHazeDensity: { value: 0 },
    uHazeColor: { value: new THREE.Color(0.66, 0.78, 0.93) },
  };
  private readonly world: TerrainRegion;
  private readonly patches: TerrainRegion[];
  readonly patchMeshes: THREE.Mesh[] = [];

  constructor(regions: TerrainRegion[]) {
    const world = regions.find(r => r.meta.id === 'world');
    if (!world) throw new Error('terrain manifest has no world region');
    this.world = world;
    this.patches = regions.filter(r => r !== world);
  }

  attach(globe: ThreeGlobe) {
    // three-globe's globe layer supplies the sphere; we supply the material.
    // Only one hole is supported by the shader; patches don't overlap by construction.
    // The hole is inset slightly so the patch overlaps the globe instead of leaving a hairline gap.
    const b = this.patches[0]?.meta.bbox;
    const inset = 0.05;
    const hole: [number, number, number, number] | undefined = b && [b[0] + inset, b[1] + inset, b[2] - inset, b[3] - inset];
    globe
      .globeCurvatureResolution(GLOBE_STEP_DEG)
      .globeMaterial(createTerrainMaterial(this.world, this.uniforms, { hole }));

    for (const region of this.patches) {
      const mesh = new THREE.Mesh(
        buildPatchGeometry(region.meta.bbox),
        createTerrainMaterial(region, this.uniforms, { skirt: true }),
      );
      mesh.name = `terrain-patch-${region.meta.id}`;
      globe.add(mesh);
      this.patchMeshes.push(mesh);
    }
  }

  get exaggeration() {
    return this.uniforms.uExag.value;
  }

  set exaggeration(v: number) {
    this.uniforms.uExag.value = v;
  }

  /** Terrain height in metres (land only; sea = 0), as rendered. */
  heightAt(lat: number, lng: number): number {
    for (const r of this.patches) {
      const [w, s, e, n] = r.meta.bbox;
      if (lng >= w && lng <= e && lat >= s && lat <= n) return this.meshHeight(r, lat, lng, PATCH_STEP_DEG, w, s);
    }
    return this.meshHeight(this.world, lat, lng, GLOBE_STEP_DEG, -180, -90);
  }

  /**
   * Height as the mesh actually renders it: sample the DEM at the four surrounding mesh vertices and
   * interpolate across the quad, so objects neither float above nor sink into coarse triangles.
   */
  private meshHeight(r: TerrainRegion, lat: number, lng: number, step: number, originLng: number, originLat: number) {
    const gx = (lng - originLng) / step, gy = (lat - originLat) / step;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const ax = gx - ix, ay = gy - iy;
    const h = (i: number, j: number) =>
      Math.max(0, sampleRegion(r, originLat + j * step, originLng + i * step) ?? sampleRegion(this.world, lat, lng) ?? 0);
    // Match the triangle split (a,b,c) / (b,d,c) used by the patch mesh.
    const h00 = h(ix, iy), h10 = h(ix + 1, iy), h01 = h(ix, iy + 1), h11 = h(ix + 1, iy + 1);
    if (ax + ay <= 1) return h00 + (h10 - h00) * ax + (h01 - h00) * ay;
    return h11 + (h01 - h11) * (1 - ax) + (h10 - h11) * (1 - ay);
  }

  /** Surface altitude in three-globe altitude units (fraction of globe radius). */
  altitudeAt(lat: number, lng: number): number {
    return (this.heightAt(lat, lng) * this.exaggeration * METRES_TO_UNITS) / GLOBE_RADIUS;
  }

  update(timeSec: number, sunDir: THREE.Vector3, realSun: boolean, dt: number, cameraAltitude: number) {
    this.uniforms.uTime.value = timeSec;
    const space = Math.min(1, Math.max(0, (cameraAltitude - 15) / 45));
    this.uniforms.uHazeDensity.value = (0.3 / Math.max(5, cameraAltitude * 10)) * (1 - space);
    this.uniforms.uSunDir.value.copy(sunDir);
    const target = realSun ? 1 : 0;
    const u = this.uniforms.uRealSun;
    u.value += (target - u.value) * Math.min(1, dt * 3);
  }
}
