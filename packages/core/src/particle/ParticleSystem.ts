import { Quaternion, Rand, Vector3 } from "@galacean/engine-math";
import { Engine } from "../Engine";
import { Transform } from "../Transform";
import { BufferBindFlag, BufferUsage, IndexBufferBinding, VertexBufferBinding, VertexElement } from "../graphic";
import { Buffer } from "./../graphic/Buffer";
import { ParticleData } from "./ParticleData";
import { ParticleRenderer } from "./ParticleRenderer";

import { VertexAttribute } from "../mesh";
import { ParticleBufferDefinition as ParticleBufferUtils } from "./ParticleBufferUtils";
import { ParticleRenderMode } from "./enums/ParticleRenderMode";
import { ParticleSimulationSpace } from "./enums/ParticleSimulationSpace";
import { EmissionModule } from "./moudules/EmissionModule";
import { MainModule } from "./moudules/MainModule";
import { ShapeModule } from "./moudules/ShapeModule";

/**
 * Particle System.
 */
export class ParticleSystem {
  /** @internal */
  private static _tempVector30: Vector3 = new Vector3();
  /** @internal */
  private static _tempVector31: Vector3 = new Vector3();

  /** @internal */
  private static _particleData: ParticleData = new ParticleData();

  /** Use auto random seed. */
  useAutoRandomSeed: boolean = true;

  /** Main module. */
  readonly main: MainModule = new MainModule(this);
  /** Emission module. */
  readonly emission: EmissionModule = new EmissionModule(this);
  /** Shape module. */
  readonly shape: ShapeModule = new ShapeModule();

  /** @internal */
  _currentParticleCount: number = 0;
  /** @internal */
  _rand: Rand = new Rand(0);
  /** @internal */
  _playTime: number = 0;

  private _firstNewElement: number = 0;
  private _firstActiveElement: number = 0;
  private _firstFreeElement: number = 0;
  private _firstRetiredElement: number = 0;

  private _waitProcessRetiredElementCount: number = 0;

  private _vertexElements: VertexElement[] = [];
  private _vertexBufferBindings: VertexBufferBinding[] = [];
  private _indexBufferBinding: IndexBufferBinding;

  private _instanceVertexBufferBinding: VertexBufferBinding;
  private _instanceVertices: Float32Array;

  private readonly _engine: Engine;
  private readonly _renderer: ParticleRenderer;
  private readonly _particleIncreaseCount: number = 128;

  /**
   * Random seed.
   * @remarks If `useAutoRandomSeed` is true, this value will be random changed when play.
   */
  get randomSeed(): number {
    return this._rand.seed;
  }

  set randomSeed(value: number) {
    this._rand.reset(value);
  }

  constructor(renderer: ParticleRenderer) {
    this._renderer = renderer;
  }

  /**
   * Emit a certain number of particles.
   * @param count - Number of particles to emit
   */
  emit(count: number): void {
    this._emit(this._playTime, count);
  }

  /**
   * @internal
   */
  _emit(time: number, count: number): void {
    const position = ParticleSystem._tempVector30;
    const direction = ParticleSystem._tempVector31;
    if (this.emission.enabled) {
      if (this.shape.enabled) {
      } else {
        const transform = this._renderer.entity.transform;
        for (let i = 0; i < count; i++) {
          position.set(0, 0, 0);
          direction.set(0, 0, -1);
          this._addNewParticle(position, direction, transform, time);
        }
      }
    }
  }

  /**
   * @internal
   */
  _update(elapsedTime: number): void {
    const lastPlayTime = this._playTime;
    this._playTime += elapsedTime;

    this._retireActiveParticles();
    this._freeRetiredParticles();

    if (this.emission.enabled) {
      this.emission._emit(lastPlayTime, this._playTime);
    }

    // Add new particles to vertex buffer when has wait process retired element or new particle
    // @todo: just update new particle buffer to instance buffer, ignore retired particle in shader, especially billboard
    if (this._waitProcessRetiredElementCount > 0 || this._firstNewElement != this._firstFreeElement) {
      this._addNewParticlesToVertexBuffer();
    }
  }

  /**
   * @internal
   */
  _reorganizeGeometryBuffers(): void {
    const renderer = this._renderer;
    const vertexElements = this._vertexElements;
    const vertexBufferBindings = this._vertexBufferBindings;

    vertexElements.length = 0;
    vertexBufferBindings.length = 0;

    if (renderer.renderMode === ParticleRenderMode.Mesh) {
      const mesh = renderer.mesh;
      if (!mesh) {
        return;
      }

      const positionElement = mesh.getVertexElement(VertexAttribute.Position);
      const colorElement = mesh.getVertexElement(VertexAttribute.Color);
      const uvElement = mesh.getVertexElement(VertexAttribute.UV);
      const positionBufferBinding = positionElement ? mesh.vertexBufferBindings[positionElement.bindingIndex] : null;
      const colorBufferBinding = colorElement ? mesh.vertexBufferBindings[colorElement.bindingIndex] : null;
      const uvBufferBinding = uvElement ? mesh.vertexBufferBindings[uvElement.bindingIndex] : null;

      if (positionBufferBinding) {
        const index = this._addVertexBufferBindingsFilterDuplicate(positionBufferBinding, vertexBufferBindings);
        vertexElements.push(
          new VertexElement(VertexAttribute.Position, positionElement.offset, positionElement.format, index)
        );
      }

      if (colorBufferBinding) {
        const index = this._addVertexBufferBindingsFilterDuplicate(colorBufferBinding, vertexBufferBindings);
        vertexElements.push(new VertexElement(VertexAttribute.Color, colorElement.offset, colorElement.format, index));
      }

      if (uvBufferBinding) {
        const index = this._addVertexBufferBindingsFilterDuplicate(uvBufferBinding, vertexBufferBindings);
        vertexElements.push(new VertexElement(VertexAttribute.UV, uvElement.offset, uvElement.format, index));
      }

      this._indexBufferBinding = mesh._indexBufferBinding;
    } else {
      vertexElements.push(ParticleBufferUtils.billboardVertexElement);
      vertexBufferBindings.push(ParticleBufferUtils.billboardVertexBufferBinding);
      this._indexBufferBinding = ParticleBufferUtils.billboardIndexBufferBinding;
    }

    const instanceVertexElements = ParticleBufferUtils.instanceVertexElements;
    const bindingIndex = vertexBufferBindings.length;
    for (let i = 0, n = instanceVertexElements.length; i < n; i++) {
      const element = instanceVertexElements[i];
      vertexElements.push(
        new VertexElement(element.attribute, element.offset, element.format, bindingIndex, element.instanceStepRate)
      );
    }
    vertexBufferBindings.length++;
  }

  /**
   * @internal
   */
  _recreateInstanceBuffer(particleCount: number): void {
    this._instanceVertexBufferBinding?.buffer.destroy();

    const stride = ParticleBufferUtils.instanceVertexStride;
    const byteLength = stride * particleCount;
    const vertexInstanceBuffer = new Buffer(
      this._engine,
      BufferBindFlag.VertexBuffer,
      byteLength,
      BufferUsage.Dynamic,
      false
    );

    const vertexBufferBindings = this._vertexBufferBindings;
    const instanceVertexBufferBinding = new VertexBufferBinding(vertexInstanceBuffer, stride);
    vertexBufferBindings[vertexBufferBindings.length - 1] = instanceVertexBufferBinding;

    const instanceVertices = new Float32Array(byteLength / 4);
    const lastInstanceVertices = this._instanceVertices;
    if (lastInstanceVertices) {
      instanceVertices.set(lastInstanceVertices);
      instanceVertexBufferBinding.buffer.setData(lastInstanceVertices);
    }

    this._instanceVertices = instanceVertices;
    this._instanceVertexBufferBinding = instanceVertexBufferBinding;
    this._currentParticleCount = particleCount;
  }

  private _addNewParticle(position: Vector3, direction: Vector3, transform: Transform, time: number): void {
    direction.normalize();

    let nextFreeElement = this._firstFreeElement + 1;
    if (nextFreeElement >= this._currentParticleCount) {
      nextFreeElement = 0;
    }

    // Check whether to expand the capacity
    if (nextFreeElement === this._firstRetiredElement) {
      const availableCapacity = this.main.maxParticles - this._currentParticleCount;
      const increaseCount = Math.min(this._particleIncreaseCount, availableCapacity);
      if (increaseCount === 0) {
        return;
      }

      this._recreateInstanceBuffer(this._currentParticleCount + increaseCount);
      if (this._firstActiveElement >= this._firstRetiredElement) {
        this._firstActiveElement += increaseCount;
      }
      this._firstRetiredElement += increaseCount;
    }

    const main = this.main;
    const out = ParticleSystem._particleData;

    const rand = this._rand;
    main.startColor.evaluate(undefined, rand.random(), out.startColor);

    if (main.startSize3D) {
      out.startSize[0] = main.startSizeX.evaluate(undefined, rand.random());
      out.startSize[1] = main.startSizeY.evaluate(undefined, rand.random());
      out.startSize[2] = main.startSizeZ.evaluate(undefined, rand.random());
    } else {
      out.startSize[0] = main.startSize.evaluate(undefined, rand.random());
    }

    if (main.startRotation3D) {
      out.startRotation[0] = main.startRotationX.evaluate(undefined, rand.random());
      out.startRotation[1] = main.startRotationY.evaluate(undefined, rand.random());
      out.startRotation[2] = main.startRotationZ.evaluate(undefined, rand.random());
    } else {
      out.startRotation[0] = main.startRotation.evaluate(undefined, rand.random());
    }

    out.startLifeTime = main.startLifetime.evaluate(undefined, rand.random());

    let pos: Vector3, rot: Quaternion;
    if (this.main.simulationSpace === ParticleSimulationSpace.World) {
      pos = transform.worldPosition;
      rot = transform.worldRotationQuaternion;
    }

    const startSpeed = main.startSpeed.evaluate(undefined, rand.random());

    const instanceVertices = this._instanceVertices;
    let offset = this._firstFreeElement * ParticleBufferUtils.instanceVertexFloatStride;

    // Position
    instanceVertices[offset] = position.x;
    instanceVertices[offset + 1] = position.y;
    instanceVertices[offset + 2] = position.z;
    // Start life time
    instanceVertices[offset + ParticleBufferUtils.startLifeTimeOffset] = time;

    // Direction
    instanceVertices[offset] = direction.x;
    instanceVertices[offset + 1] = direction.y;
    instanceVertices[offset + 2] = direction.z;
    // Time
    instanceVertices[offset + ParticleBufferUtils.timeOffset] = time;

    // Color
    instanceVertices[offset + 8] = out.startColor.r;
    instanceVertices[offset + 9] = out.startColor.g;
    instanceVertices[offset + 10] = out.startColor.b;
    instanceVertices[offset + 11] = out.startColor.a;

    // Start size
    instanceVertices[offset + 12] = out.startSize[0];
    instanceVertices[offset + 13] = out.startSize[1];
    instanceVertices[offset + 14] = out.startSize[2];

    // Start rotation
    instanceVertices[offset + 15] = out.startRotation[0];
    instanceVertices[offset + 16] = out.startRotation[1];
    instanceVertices[offset + 17] = out.startRotation[2];

    // Start speed
    instanceVertices[offset + 18] = startSpeed;

    // Color, size, rotation, texture animation
    instanceVertices[offset + 19] = rand.random();
    instanceVertices[offset + 20] = rand.random();
    instanceVertices[offset + 21] = rand.random();
    instanceVertices[offset + 22] = rand.random();

    // Velocity random
    instanceVertices[offset + 23] = rand.random();
    instanceVertices[offset + 24] = rand.random();
    instanceVertices[offset + 25] = rand.random();
    instanceVertices[offset + 26] = rand.random();

    if (this.main.simulationSpace === ParticleSimulationSpace.World) {
      // Simulation world position
      instanceVertices[offset + 27] = pos.x;
      instanceVertices[offset + 28] = pos.y;
      instanceVertices[offset + 29] = pos.z;

      // Simulation world position
      instanceVertices[offset + 30] = rot.x;
      instanceVertices[offset + 31] = rot.y;
      instanceVertices[offset + 32] = rot.z;
      instanceVertices[offset + 33] = rot.w;
    }

    // Simulation UV
    instanceVertices[offset + ParticleBufferUtils.simulationOffset] = out.startUVInfo[0];
    instanceVertices[offset + 35] = out.startUVInfo[1];
    instanceVertices[offset + 36] = out.startUVInfo[2];
    instanceVertices[offset + 37] = out.startUVInfo[3];

    this._firstFreeElement = nextFreeElement;
  }

  private _retireActiveParticles(): void {
    const epsilon = 0.0001;
    const frameCount = this._engine.time.frameCount;
    const instanceVertices = this._instanceVertices;

    // let firstActive = this._firstActiveElement;
    while (this._firstActiveElement != this._firstNewElement) {
      const activeParticleOffset = this._firstActiveElement * ParticleBufferUtils.instanceVertexFloatStride;
      const activeParticleTimeOffset = activeParticleOffset + ParticleBufferUtils.timeOffset;

      const particleAge = this._playTime - instanceVertices[activeParticleTimeOffset];
      if (particleAge + epsilon < instanceVertices[activeParticleOffset + ParticleBufferUtils.startLifeTimeOffset]) {
        break;
      }

      // Store frame count in time offset to free retired particle
      instanceVertices[activeParticleTimeOffset] = frameCount;
      if (++this._firstActiveElement >= this._currentParticleCount) {
        this._firstActiveElement = 0;
      }

      // Record wait process retired element count
      this._waitProcessRetiredElementCount++;
    }
  }

  private _freeRetiredParticles(): void {
    const frameCount = this._engine.time.frameCount;

    while (this._firstRetiredElement != this._firstActiveElement) {
      const offset =
        this._firstRetiredElement * ParticleBufferUtils.instanceVertexFloatStride +
        ParticleBufferUtils.startLifeTimeOffset;
      const age = frameCount - this._instanceVertices[offset];

      // WebGL don't support map buffer range, so off this optimization
      if (age < 0) {
        break;
      }

      if (++this._firstRetiredElement >= this._currentParticleCount) {
        this._firstRetiredElement = 0;
      }
    }
  }

  private _addNewParticlesToVertexBuffer(): void {
    const byteStride = ParticleBufferUtils.instanceVertexStride;
    const firstNewElement = this._firstNewElement;
    const firstFreeElement = this._firstFreeElement;
    const start = firstNewElement * byteStride;
    const instanceBuffer = this._instanceVertexBufferBinding.buffer;
    const dataBuffer = this._instanceVertices.buffer;

    if (firstNewElement < firstFreeElement) {
      instanceBuffer.setData(dataBuffer, start, start, (firstFreeElement - firstNewElement) * byteStride);
    } else {
      instanceBuffer.setData(dataBuffer, start, start, (this._currentParticleCount - firstNewElement) * byteStride);

      if (firstFreeElement > 0) {
        instanceBuffer.setData(dataBuffer, 0, 0, firstFreeElement * byteStride);
      }
    }
    this._firstNewElement = firstFreeElement;
  }

  private _createParticleData(main: MainModule, out: ParticleData): void {}

  private _addVertexBufferBindingsFilterDuplicate(
    vertexBufferBinding: VertexBufferBinding,
    out: VertexBufferBinding[]
  ): number {
    let index = 0;
    for (let n = out.length; index < n; index++) {
      if (out[index] === vertexBufferBinding) {
        return index;
      }
    }
    out.push(vertexBufferBinding);
    return index;
  }
}
