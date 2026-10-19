// Generated from schema/frame_sample.fbs (manually curated for browser use)
import * as flatbuffers from 'flatbuffers';

export class FrameSample {
  bb: flatbuffers.ByteBuffer | null = null;
  bb_pos = 0;

  __init(i: number, bb: flatbuffers.ByteBuffer): FrameSample {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }

  static getRootAsFrameSample(bb: flatbuffers.ByteBuffer, obj?: FrameSample): FrameSample {
    return (obj || new FrameSample()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }

  static bufferHasIdentifier(bb: flatbuffers.ByteBuffer): boolean {
    return bb.__has_identifier('NBFR');
  }

  frame(): number {
    const o = this.bb!.__offset(this.bb_pos, 4);
    return o ? this.bb!.readUint32(this.bb_pos + o) : 0;
  }

  bodyCount(): number {
    const o = this.bb!.__offset(this.bb_pos, 6);
    return o ? this.bb!.readUint32(this.bb_pos + o) : 0;
  }

  simDt(): number {
    const o = this.bb!.__offset(this.bb_pos, 8);
    return o ? this.bb!.readFloat32(this.bb_pos + o) : 0.0;
  }

  bboxMinX(): number {
    const o = this.bb!.__offset(this.bb_pos, 10);
    return o ? this.bb!.readFloat32(this.bb_pos + o) : 0.0;
  }

  bboxMinY(): number {
    const o = this.bb!.__offset(this.bb_pos, 12);
    return o ? this.bb!.readFloat32(this.bb_pos + o) : 0.0;
  }

  bboxMinZ(): number {
    const o = this.bb!.__offset(this.bb_pos, 14);
    return o ? this.bb!.readFloat32(this.bb_pos + o) : 0.0;
  }

  bboxExtentX(): number {
    const o = this.bb!.__offset(this.bb_pos, 16);
    return o ? this.bb!.readFloat32(this.bb_pos + o) : 0.0;
  }

  bboxExtentY(): number {
    const o = this.bb!.__offset(this.bb_pos, 18);
    return o ? this.bb!.readFloat32(this.bb_pos + o) : 0.0;
  }

  bboxExtentZ(): number {
    const o = this.bb!.__offset(this.bb_pos, 20);
    return o ? this.bb!.readFloat32(this.bb_pos + o) : 0.0;
  }

  bodies(index: number): number | null {
    const o = this.bb!.__offset(this.bb_pos, 22);
    return o ? this.bb!.readUint16(this.bb!.__vector(this.bb_pos + o) + index * 2) : null;
  }

  bodiesLength(): number {
    const o = this.bb!.__offset(this.bb_pos, 22);
    return o ? this.bb!.__vector_len(this.bb_pos + o) : 0;
  }

  bodiesArray(): Uint16Array | null {
    const o = this.bb!.__offset(this.bb_pos, 22);
    if (!o) return null;
    const start = this.bb!.__vector(this.bb_pos + o);
    const length = this.bb!.__vector_len(this.bb_pos + o);
    const bytes = this.bb!.bytes();
    const byteOffset = bytes.byteOffset + start;
    const byteLength = bytes.buffer.byteLength;
    if (byteOffset < 0 || byteOffset + length * 2 > byteLength) return null;
    try {
      return new Uint16Array(bytes.buffer, byteOffset, length);
    } catch {
      return null;
    }
  }

  static getFullyQualifiedName(): string {
    return 'nbody.FrameSample';
  }
}
