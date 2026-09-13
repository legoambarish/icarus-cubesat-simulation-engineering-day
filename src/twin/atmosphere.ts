/**
 * ATMOSPHERE SHELL
 * =============================================================================
 * A sphere ~2.8 % larger than the Earth, rendered BACK-face only and blended
 * additively.
 *
 * Why back faces: the near hemisphere of the shell is culled, so the only
 * fragments that survive are the far hemisphere. Everywhere that far hemisphere
 * sits directly behind the planet it fails the depth test against the Earth, so
 * what is left is exactly the annulus just outside the planet's silhouette -
 * a thin lit rim, not a glowing ball.
 *
 * The rim only lights up where the limb is actually in sunlight, which means
 * the atmosphere goes dark on the night side and the terminator stays readable.
 */

import { AdditiveBlending, BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

const vertexShader = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 sunDirection;   // world space, unit
  uniform vec3 glowColor;
  uniform float intensity;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);

    // Strongest exactly at the limb, where the view ray is tangent to the shell.
    float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 3.4);

    // N points radially outward, so dot(N, L) says whether this piece of the
    // edge is on the sunlit side of the planet.
    float sunFacing = clamp(dot(N, normalize(sunDirection)) * 1.15 + 0.2, 0.0, 1.0);

    float a = rim * sunFacing * intensity;
    gl_FragColor = vec4(glowColor * a, a);
  }
`;

export interface AtmosphereObject {
  mesh: Mesh;
  setSunDirection: (dir: Vector3) => void;
  dispose: () => void;
}

export function createAtmosphere(earthRadiusUnits: number): AtmosphereObject {
  const geometry = new SphereGeometry(earthRadiusUnits * 1.028, 72, 48);
  const material = new ShaderMaterial({
    uniforms: {
      sunDirection: { value: new Vector3(1, 0, 0) },
      glowColor: { value: new Color(0x5aa6ff) },
      intensity: { value: 1.5 },
    },
    vertexShader,
    fragmentShader,
    side: BackSide,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'Atmosphere';
  mesh.renderOrder = 1;

  return {
    mesh,
    setSunDirection: (dir) => {
      (material.uniforms.sunDirection!.value as Vector3).copy(dir);
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
