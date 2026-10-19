import { ByteBuffer } from 'flatbuffers';
import { FrameSample } from '../flatbuffers/frame_sample_generated';
import type { FramePayload } from '../state/useFrameStore';

// Decode a single length-delimited FlatBuffer frame with 16-bit quantized positions.
export function decodeFrame(buf: Uint8Array): FramePayload | null {
  const bb = new ByteBuffer(buf);
  if (!FrameSample.bufferHasIdentifier(bb)) return null;

  const frame = FrameSample.getRootAsFrameSample(bb);
  const bodyCount = frame.bodyCount();
  const bodies = frame.bodiesArray();
  if (!bodies || bodies.length < bodyCount * 3) {
    console.warn('[frames] bodies array missing or short', {
      bodyCount,
      len: bodies ? bodies.length : 0,
      bufLen: buf.byteLength
    });
    return null;
  }

  return {
    frame: frame.frame(),
    bodyCount,
    simDt: frame.simDt(),
    minX: frame.bboxMinX(),
    minY: frame.bboxMinY(),
    minZ: frame.bboxMinZ(),
    extentX: frame.bboxExtentX(),
    extentY: frame.bboxExtentY(),
    extentZ: frame.bboxExtentZ(),
    bodies,
    receivedAt: performance.now(),
    bytes: buf.byteLength
  };
}
