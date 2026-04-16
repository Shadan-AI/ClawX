import { useEffect, useRef, useState } from 'react';

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  size: number;
  restitution: number;
}

interface ConfettiPhysicsProps {
  particles: Array<{
    id: number;
    x: number;
    y: number;
    explosionX: number;
    explosionY: number;
    color: string;
    size: number;
  }>;
  onComplete?: (id: number) => void;
}

export function ConfettiPhysics({ particles: initialParticles, onComplete }: ConfettiPhysicsProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const animationFrameRef = useRef<number>();
  const lastTimeRef = useRef<number>(Date.now());
  const processedIdsRef = useRef<Set<number>>(new Set());
  const isProcessingRef = useRef(false);

  // 初始化粒子 - 只处理新的粒子
  useEffect(() => {
    // 防止重复处理（React Strict Mode 会导致 useEffect 执行两次）
    if (isProcessingRef.current) {
      return;
    }
    
    const newParticles = initialParticles.filter(p => !processedIdsRef.current.has(p.id));
    
    if (newParticles.length === 0) {
      return;
    }
    
    isProcessingRef.current = true;
    
    const particles: Particle[] = newParticles.map(p => {
      processedIdsRef.current.add(p.id);
      return {
        id: p.id,
        x: p.x,
        y: p.y,
        vx: p.explosionX / 15,
        vy: p.explosionY / 15 - 5,
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 10,
        color: p.color,
        size: p.size,
        restitution: 0.3 + Math.random() * 0.2,
      };
    });
    
    setParticles(prev => [...prev, ...particles]);
    
    // 重置标志，允许下次处理
    setTimeout(() => {
      isProcessingRef.current = false;
    }, 50);
  }, [initialParticles]);

  // 物理模拟
  useEffect(() => {
    const gravity = 0.5;
    const friction = 0.99;
    const groundY = window.innerHeight - 10;

    const animate = () => {
      const now = Date.now();
      const deltaTime = Math.min((now - lastTimeRef.current) / 16.67, 2);
      lastTimeRef.current = now;

      setParticles(prevParticles => {
        if (prevParticles.length === 0) return prevParticles;

        const updatedParticles = prevParticles.map(particle => {
          let { x, y, vx, vy, rotation, rotationSpeed } = particle;

          vy += gravity * deltaTime;
          x += vx * deltaTime;
          y += vy * deltaTime;
          vx *= friction;
          rotation += rotationSpeed * deltaTime;

          if (y + particle.size / 2 >= groundY) {
            y = groundY - particle.size / 2;
            vy = -vy * particle.restitution;
            vx *= 0.9;
            rotationSpeed *= 0.8;

            if (Math.abs(vy) < 0.5) {
              vy = 0;
            }
          }

          if (x - particle.size / 2 < 0) {
            x = particle.size / 2;
            vx = -vx * 0.8;
          } else if (x + particle.size / 2 > window.innerWidth) {
            x = window.innerWidth - particle.size / 2;
            vx = -vx * 0.8;
          }

          return {
            ...particle,
            x,
            y,
            vx,
            vy,
            rotation,
            rotationSpeed,
          };
        });

        const activeParticles = updatedParticles.filter(p => {
          const isStatic = Math.abs(p.vy) < 0.1 && p.y >= groundY - p.size;
          if (isStatic && Date.now() - p.id > 2000) {
            processedIdsRef.current.delete(p.id);
            onComplete?.(p.id);
            return false;
          }
          return true;
        });

        return activeParticles;
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [onComplete]);

  return (
    <>
      {particles.map(particle => (
        <div
          key={particle.id}
          className="fixed rounded-sm pointer-events-none z-[9999]"
          style={{
            left: `${particle.x}px`,
            top: `${particle.y}px`,
            width: `${particle.size}px`,
            height: `${particle.size}px`,
            backgroundColor: particle.color,
            transform: `translate(-50%, -50%) rotate(${particle.rotation}deg)`,
            transition: 'none',
          }}
        />
      ))}
    </>
  );
}
