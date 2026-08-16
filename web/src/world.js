/**
 * Load the baked world and turn it into three.js meshes.
 *
 * Terrain arrives as bare height grids and the mesh is assembled here, which
 * keeps the download at 1.6 MB instead of tens of megabytes of redundant
 * positions and normals.
 */
import * as THREE from "three";

const WORLD = "./world";

export async function loadMeta() {
  const r = await fetch(`${WORLD}/meta.json`);
  if (!r.ok) throw new Error(`meta.json ${r.status}`);
  return r.json();
}

async function loadBin(name) {
  const r = await fetch(`${WORLD}/${name}.bin`);
  if (!r.ok) throw new Error(`${name}.bin ${r.status}`);
  return r.arrayBuffer();
}

/** Pull one attribute block out of a packed mesh binary. */
function attr(buf, layout, key) {
  const l = layout[key];
  return new Float32Array(buf, l.offset, l.count * l.components);
}

function indices(buf, layout) {
  return new Uint32Array(buf, layout.index.offset, layout.index.count);
}

// --------------------------------------------------------------------- terrain

export async function buildTerrain(meta, onTexture) {
  const buf = await loadBin("terrain");
  const { grid, chunks, chunk_m } = meta.terrain;
  const half = meta.extent_m / 2;
  const all = new Float32Array(buf);
  const group = new THREE.Group();
  group.name = "terrain";
  const heightChunks = [];
  const loader = new THREE.TextureLoader();

  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      const ci = cz * chunks + cx;
      const h = all.subarray(ci * grid * grid, (ci + 1) * grid * grid);
      heightChunks.push(h);

      const x0 = -half + cx * chunk_m;
      const z0 = -half + cz * chunk_m;
      const n = grid;
      const pos = new Float32Array(n * n * 3);
      const uv = new Float32Array(n * n * 2);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          pos[k * 3] = x0 + (i / (n - 1)) * chunk_m;
          pos[k * 3 + 1] = h[j * n + i];
          pos[k * 3 + 2] = z0 + (j / (n - 1)) * chunk_m;
          uv[k * 2] = i / (n - 1);
          // The imagery tile has north at its top row. three.js flips textures
          // on upload, so north (j = 0) has to land at v = 1 or the whole world
          // is mirrored about the horizontal.
          uv[k * 2 + 1] = 1 - j / (n - 1);
        }
      }
      const idx = new Uint32Array((n - 1) * (n - 1) * 6);
      let p = 0;
      for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
          idx[p++] = a; idx[p++] = c; idx[p++] = b;
          idx[p++] = b; idx[p++] = c; idx[p++] = d;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      const tex = loader.load(`${WORLD}/tex/${cx}_${cz}.jpg`, onTexture, undefined, onTexture);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 16;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0.0 });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.userData.chunk = { cx, cz, x0, z0 };
      group.add(mesh);
    }
  }
  return { group, heightChunks, grid, chunks, chunk_m, half };
}

// ----------------------------------------------------------------------- roads

/**
 * Lane markings are drawn procedurally from the road's own attributes rather
 * than sampled from a texture. Widths vary per way, so a fixed atlas would
 * either stretch or repeat wrong; this stays sharp at any distance and costs
 * one extra vec2 per vertex.
 */
const ROAD_VERT = /* glsl */`
  attribute vec2 road;
  varying vec2 vUv;
  varying vec2 vRoad;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vRoad = road;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const ROAD_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;      // x = metres from centreline, y = metres along
  varying vec2 vRoad;    // x = half width, y = lane count (0 = junction)
  varying vec3 vWorld;
  uniform vec3 uSun;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  float band(float v, float centre, float halfWidth) {
    float d = abs(v - centre);
    float aa = fwidth(v) * 1.2 + 0.001;
    return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, d);
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

  void main() {
    float off = vUv.x;
    float along = vUv.y;
    float hw = vRoad.x;
    float lanes = vRoad.y;

    // Asphalt with a little large-scale mottling so it is not a flat grey slab.
    float n = hash(floor(vWorld.xz * 0.35)) * 0.06 + hash(floor(vWorld.xz * 2.1)) * 0.03;
    vec3 col = vec3(0.085, 0.088, 0.093) + n;

    if (lanes > 0.5) {
      float paint = 0.0;
      vec3 paintCol = vec3(0.80, 0.80, 0.78);

      // Solid white edge line, held just inside the kerb.
      float edge = hw - 0.35;
      paint = max(paint, band(abs(off), edge, 0.09));

      if (hw > 4.2) {
        // Wide enough to be two-way with a marked centre: double yellow.
        float c = band(abs(off), 0.18, 0.08);
        if (c > 0.0) paintCol = mix(paintCol, vec3(0.85, 0.68, 0.16), c);
        paint = max(paint, c);

        // Dashed lane dividers every lane width out from the centre.
        float laneW = (hw * 2.0) / max(lanes, 2.0);
        float dash = step(fract(along / 12.0), 0.32);
        for (int i = 1; i < 4; i++) {
          float d = float(i) * laneW;
          if (d > edge - 0.6) break;
          paint = max(paint, band(abs(off), d, 0.07) * dash);
        }
      } else if (hw > 2.6) {
        // Neighbourhood street: a single dashed centre line, no yellow.
        float dash = step(fract(along / 9.0), 0.3);
        paint = max(paint, band(abs(off), 0.0, 0.07) * dash);
      }
      col = mix(col, paintCol, paint * 0.92);
    }

    // Flat lambert against the sun direction. The road is planar, so a real
    // normal buys nothing here.
    float lambert = 0.55 + 0.45 * max(dot(vec3(0.0, 1.0, 0.0), normalize(uSun)), 0.0);
    col *= lambert;

    float depth = length(vWorld - cameraPosition);
    float fog = smoothstep(uFogNear, uFogFar, depth);
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
    #include <colorspace_fragment>
  }
`;

export async function buildRoads(meta, sun, fog) {
  const buf = await loadBin("roads");
  const l = meta.roads;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(attr(buf, l, "position"), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(attr(buf, l, "uv"), 2));
  geo.setAttribute("road", new THREE.BufferAttribute(attr(buf, l, "road"), 2));
  geo.setIndex(new THREE.BufferAttribute(indices(buf, l), 1));
  geo.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    vertexShader: ROAD_VERT,
    fragmentShader: ROAD_FRAG,
    uniforms: {
      uSun: { value: sun.clone() },
      uFogColor: { value: new THREE.Color(fog.color) },
      uFogNear: { value: fog.near },
      uFogFar: { value: fog.far },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "roads";
  mesh.renderOrder = 1;
  return { mesh, positions: geo.attributes.position.array, index: geo.index.array };
}

// ------------------------------------------------------------------- buildings

export async function buildBuildings(meta) {
  const buf = await loadBin("buildings");
  const l = meta.buildings;
  const pos = attr(buf, l, "position");
  const nrm = attr(buf, l, "normal");
  const info = attr(buf, l, "info");

  // OSM carries no heights worth using here and no colours at all, so the
  // variation is generated: a stable per-building seed picks a stucco tone,
  // and roofs go flat grey. It reads as a neighbourhood instead of a spreadsheet.
  const col = new Float32Array((pos.length / 3) * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.length / 3; i++) {
    const seed = info[i * 2];
    const isRoof = info[i * 2 + 1] > 0.5;
    if (isRoof) {
      const g = 0.26 + seed * 0.1;
      c.setRGB(g, g * 0.99, g * 0.95);
    } else {
      c.setHSL(0.07 + seed * 0.06, 0.13 + seed * 0.12, 0.52 + seed * 0.16);
    }
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(indices(buf, l), 1));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.0,
  }));
  mesh.name = "buildings";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ----------------------------------------------------------------------- water

export async function buildWater(meta) {
  const buf = await loadBin("water");
  const l = meta.water;
  if (!l.index.count) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(attr(buf, l, "position"), 3));
  geo.setIndex(new THREE.BufferAttribute(indices(buf, l), 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0x2c4a5c, roughness: 0.14, metalness: 0.35,
    transparent: true, opacity: 0.9,
  }));
  mesh.name = "water";
  mesh.renderOrder = 2;
  return mesh;
}
