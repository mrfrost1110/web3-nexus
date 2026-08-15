"use client";

/**
 * Decorative WebGL scene for the landing page hero.
 *
 * Renders a drifting particle field around a rotating core, standing in for nodes around a
 * ledger. Purely visual — it reads no chain state and has no dependency on wallet
 * connection.
 *
 * Imported by `app/page.tsx` through `next/dynamic` with `ssr: false`. Three.js needs a
 * real WebGL context, which does not exist during server rendering, and the dynamic import
 * also keeps the Three.js bundle out of the initial page payload.
 */

import React, { useRef, useState, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

/** Half-width of the invisible cube the particles bounce inside. */
const BOUNDARY = 5.5;

/** How strongly particles drift toward the cursor, per frame. */
const MOUSE_PULL = 0.001;

/**
 * Drifting particle field representing network nodes.
 *
 * Uses a single `instancedMesh` rather than one mesh per particle: 120 individual meshes
 * would mean 120 draw calls per frame, while instancing issues one. This is what keeps the
 * scene cheap enough to run behind the hero copy.
 *
 * @param count Number of particles to render.
 */
function BlockchainNodes({ count = 120 }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const { mouse } = useThree();

  // One scratch object reused for every particle every frame. Its only job is to convert
  // position and scale into a matrix; allocating a new Object3D per particle would create
  // thousands of short-lived objects per second and cause visible GC stutter.
  const dummy = new THREE.Object3D();

  // Seeded once via lazy initial state. Passing the array directly would re-randomize the
  // field on every render and make the particles jump.
  const [particles] = useState(() => {
    const temp = [];
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 11;
      const y = (Math.random() - 0.5) * 11;
      const z = (Math.random() - 0.5) * 11;
      const speedX = (Math.random() - 0.5) * 0.01;
      const speedY = (Math.random() - 0.5) * 0.01;
      const speedZ = (Math.random() - 0.5) * 0.01;
      const scale = Math.random() * 0.15 + 0.05;
      temp.push({ x, y, z, speedX, speedY, speedZ, scale });
    }
    return temp;
  });

  // Runs once per animation frame. Particle positions are mutated in place and written
  // straight to the instance matrix — deliberately outside React state, since routing 120
  // position updates through a re-render 60 times a second would be far too expensive.
  useFrame(() => {
    if (!meshRef.current) return;

    particles.forEach((p, idx) => {
      p.x += p.speedX;
      p.y += p.speedY;
      p.z += p.speedZ;

      // Flip velocity at the boundary to keep the field inside the camera's view.
      if (Math.abs(p.x) > BOUNDARY) p.speedX *= -1;
      if (Math.abs(p.y) > BOUNDARY) p.speedY *= -1;
      if (Math.abs(p.z) > BOUNDARY) p.speedZ *= -1;

      // Gentle attraction toward the cursor. `mouse` is normalized to [-1, 1], scaled here
      // to roughly match the field's extent.
      p.x += (mouse.x * 2.5 - p.x) * MOUSE_PULL;
      p.y += (mouse.y * 2.5 - p.y) * MOUSE_PULL;

      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(p.scale, p.scale, p.scale);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(idx, dummy.matrix);
    });

    // Without this flag Three.js keeps the previous frame's matrices and nothing moves.
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    // `args` supplies geometry and material positionally; both are passed as null because
    // the child elements below provide them, and `count` sets the instance buffer size.
    <instancedMesh ref={meshRef} args={[null as any, null as any, count]}>
      <sphereGeometry args={[0.3, 8, 8]} />
      {/* `meshBasicMaterial` ignores scene lighting, so the particles hold a constant
          neon color instead of falling into shadow as they drift. */}
      <meshBasicMaterial color="#06b6d4" transparent opacity={0.65} wireframe />
    </instancedMesh>
  );
}

/**
 * Rotating centerpiece: a torus knot inside a counter-rotating ring and a small core.
 *
 * Rotation is driven from the clock's elapsed time rather than incremented per frame, so
 * the animation runs at the same speed regardless of frame rate.
 */
function NexusCore() {
  const coreRef = useRef<THREE.Group>(null);
  const outerRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const time = state.clock.getElapsedTime();
    if (coreRef.current) {
      coreRef.current.rotation.y = time * 0.25;
      coreRef.current.rotation.x = time * 0.15;
    }
    // Negative coefficients spin the outer ring against the group it sits in, so the two
    // motions read as separate instead of merging into one rigid rotation.
    if (outerRef.current) {
      outerRef.current.rotation.z = -time * 0.1;
      outerRef.current.rotation.y = -time * 0.15;
    }
  });

  return (
    <group ref={coreRef}>
      {/* Central wireframe torus knot */}
      <mesh>
        <torusKnotGeometry args={[0.9, 0.3, 150, 16]} />
        <meshBasicMaterial
          color="#a855f7" // --neon-purple
          wireframe
          transparent
          opacity={0.8}
        />
      </mesh>

      {/* Orbital ring, counter-rotating via `outerRef` */}
      <mesh ref={outerRef}>
        <torusGeometry args={[1.9, 0.03, 16, 100]} />
        <meshBasicMaterial
          color="#06b6d4" // --neon-cyan
          wireframe
          transparent
          opacity={0.4}
        />
      </mesh>

      {/* Inner core sphere */}
      <mesh>
        <sphereGeometry args={[0.35, 16, 16]} />
        <meshBasicMaterial
          color="#ec4899" // --neon-pink
          wireframe
        />
      </mesh>
    </group>
  );
}

export default function WebGLCanvas() {
  // Second mount guard, in addition to the dynamic import's `ssr: false`. The effect only
  // runs in the browser, so the canvas is created after hydration and cannot mismatch the
  // server-rendered tree. Until then a matching solid block holds the layout, avoiding a
  // reflow when the scene appears.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div style={{ width: "100%", height: "100%", background: "#030712" }} />;
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <Canvas
        camera={{ position: [0, 0, 7], fov: 60 }}
        gl={{ antialias: true }}
        style={{ pointerEvents: "auto" }}
      >
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} intensity={1.5} />
        <BlockchainNodes count={120} />
        <NexusCore />
        {/* Rotation only. Zoom and pan are disabled so scrolling over the hero scrolls the
            page rather than dollying the camera. */}
        <OrbitControls enableZoom={false} enablePan={false} autoRotate={false} />
      </Canvas>
    </div>
  );
}
