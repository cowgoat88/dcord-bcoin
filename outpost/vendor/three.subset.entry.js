// Entry for vendor/three.subset.min.js: exactly the three.js 0.186.1 exports
// that holo-gl.js uses (plus ShaderMaterial and PointLight, which the Doomstar beam and its flash need).
// To rebuild, in a scratch directory with `npm i three@0.186.1 esbuild`:
//   cp <repo>/outpost/vendor/three.subset.entry.js entry.js
//   npx esbuild entry.js --bundle --minify --format=iife --global-name=THREE --outfile=three.subset.min.js
// then prepend the header comment from the committed bundle.
export {
  WebGLRenderer, WebGLRenderTarget, Scene, PerspectiveCamera, Group, Mesh, InstancedMesh, LineSegments, Points,
  BufferGeometry, BufferAttribute, BoxGeometry, CircleGeometry, CylinderGeometry, DodecahedronGeometry,
  EdgesGeometry, ExtrudeGeometry, OctahedronGeometry, PlaneGeometry, ShapeGeometry, SphereGeometry, TorusGeometry,
  Shape, MeshStandardMaterial, MeshBasicMaterial, LineBasicMaterial, PointsMaterial, ShaderMaterial,
  AmbientLight, DirectionalLight, HemisphereLight, PointLight, Fog, Color, Vector2, Vector3, Matrix4, Quaternion,
  CanvasTexture, AdditiveBlending, DoubleSide, DynamicDrawUsage, HalfFloatType, LinearFilter,
  RepeatWrapping, ClampToEdgeWrapping, SRGBColorSpace
} from 'three';
export { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
export { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
export { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
export { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
