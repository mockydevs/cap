import type { FfmpegRenderManifest } from "@cap/editor-domain";

type Transform = FfmpegRenderManifest["video"][number]["transform"];
type ZoomKeyframe = Transform["zoomKeyframes"][number];
type AudioSettings = FfmpegRenderManifest["audio"][number]["settings"];
type Overlay = FfmpegRenderManifest["overlays"][number];

/** "#RRGGBB" or "#RRGGBBAA" -> FFmpeg's 0xRRGGBB[@alpha] color syntax. */
export function ffmpegColor(hex: string): string {
  const rgb = hex.slice(1, 7);
  if (hex.length === 9) {
    const alpha = Number.parseInt(hex.slice(7, 9), 16) / 255;
    return `0x${rgb}@${alpha.toFixed(3)}`;
  }
  return `0x${rgb}`;
}

/**
 * FFmpeg's `atempo` filter is only valid for a single 0.5x-2.0x change, so a
 * rate outside that range is expressed as a chain of stages whose product
 * equals it.
 */
export function atempoChain(rate: number): string[] {
  const stages: string[] = [];
  let remaining = rate;
  while (remaining > 2) {
    stages.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    stages.push("atempo=0.5");
    remaining /= 0.5;
  }
  stages.push(`atempo=${remaining.toFixed(6)}`);
  return stages;
}

/**
 * Builds a piecewise-linear FFmpeg expression (a nested `if(lt(t,k),...)`
 * chain) interpolating `pick(keyframe)` over clip-local time `t`, in seconds.
 * Keyframes must already be sorted by timeMs. A single keyframe yields a
 * constant expression.
 */
export function piecewiseLinearExpr(
  keyframes: readonly ZoomKeyframe[],
  pick: (keyframe: ZoomKeyframe) => number,
): string {
  if (keyframes.length === 1) return pick(keyframes[0]!).toFixed(6);
  const lerp = (a: ZoomKeyframe, b: ZoomKeyframe) => {
    const t0 = a.timeMs / 1000;
    const t1 = b.timeMs / 1000;
    const v0 = pick(a);
    const v1 = pick(b);
    if (t1 === t0) return v1.toFixed(6);
    return `(${v0.toFixed(6)}+(${v1.toFixed(6)}-${v0.toFixed(6)})*(t-${t0.toFixed(6)})/${(t1 - t0).toFixed(6)})`;
  };
  let expr = pick(keyframes[keyframes.length - 1]!).toFixed(6);
  for (let i = keyframes.length - 1; i > 0; i -= 1) {
    const boundaryT = (keyframes[i]!.timeMs / 1000).toFixed(6);
    const segment = lerp(keyframes[i - 1]!, keyframes[i]!);
    expr = `if(lt(t,${boundaryT}),${segment},${expr})`;
  }
  return expr;
}

/**
 * A time-varying `crop` filter simulating Ken Burns-style pan/zoom. Keyframe
 * `x`/`y` are normalized (0-1) focal-point fractions of the frame; `scale`
 * is a zoom multiplier (1 = no zoom). Clamped so the crop window never
 * leaves the source frame.
 */
export function zoomCropFilter(keyframes: readonly ZoomKeyframe[]): string {
  const sorted = [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
  const scale = piecewiseLinearExpr(sorted, (k) => k.scale);
  const panX = piecewiseLinearExpr(sorted, (k) => k.x);
  const panY = piecewiseLinearExpr(sorted, (k) => k.y);
  const w = `(iw/(${scale}))`;
  const h = `(ih/(${scale}))`;
  const x = `max(0,min(iw-${w},(${panX})*iw-${w}/2))`;
  const y = `max(0,min(ih-${h},(${panY})*ih-${h}/2))`;
  return `crop=w='${w}':h='${h}':x='${x}':y='${y}':eval=frame`;
}

/** The FFmpeg filter chain transforming one decoded video clip, before it is composited. */
export function videoClipFilterChain(input: {
  readonly transform: Transform;
}): string {
  const stages: string[] = [];
  const crop = input.transform.crop;
  if (crop.top || crop.right || crop.bottom || crop.left) {
    stages.push(
      `crop=w='iw*(1-${crop.left}-${crop.right})':h='ih*(1-${crop.top}-${crop.bottom})':x='iw*${crop.left}':y='ih*${crop.top}'`,
    );
  }
  if (input.transform.zoomKeyframes.length)
    stages.push(zoomCropFilter(input.transform.zoomKeyframes));
  // Fit within the transform box preserving aspect ratio, matching the
  // pre-transform baseline behavior, rather than stretching to fill it.
  const w = Math.round(input.transform.width);
  const h = Math.round(input.transform.height);
  stages.push(
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    "format=rgba",
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`,
  );
  if (input.transform.rotationDegrees !== 0) {
    const radians = (input.transform.rotationDegrees * Math.PI) / 180;
    stages.push(
      `rotate=${radians.toFixed(6)}:fillcolor=none:ow=rotw(${radians.toFixed(6)}):oh=roth(${radians.toFixed(6)})`,
    );
  }
  if (input.transform.opacity !== 1)
    stages.push(`colorchannelmixer=aa=${input.transform.opacity}`);
  return stages.join(",");
}

/** The FFmpeg filter chain for one audio clip: speed, gain, fades. Returns undefined for a muted clip. */
export function audioClipFilterChain(
  settings: AudioSettings,
  clipDurationSeconds: number,
  playbackRate: number,
): string | undefined {
  if (settings.muted) return undefined;
  const stages: string[] = [];
  if (playbackRate !== 1) stages.push(...atempoChain(playbackRate));
  if (settings.gainDb !== 0) stages.push(`volume=${settings.gainDb}dB`);
  if (settings.fadeInMs > 0)
    stages.push(`afade=t=in:st=0:d=${(settings.fadeInMs / 1000).toFixed(3)}`);
  if (settings.fadeOutMs > 0) {
    const start = Math.max(
      0,
      clipDurationSeconds - settings.fadeOutMs / 1000,
    ).toFixed(3);
    stages.push(
      `afade=t=out:st=${start}:d=${(settings.fadeOutMs / 1000).toFixed(3)}`,
    );
  }
  return stages.length ? stages.join(",") : "anull";
}

/**
 * A self-contained (no input pad required) filter chain that generates a
 * TEXT, RECTANGLE, or ELLIPSE overlay's own WxH layer from nothing, starting
 * from a transparent `color` source. IMAGE overlays instead scale a decoded
 * asset input (see imageOverlayFilterChain); BLUR reads back a crop of the
 * current composite (wired in ffmpeg.ts, since only it has that label).
 */
export function generatedOverlayFilterChain(input: {
  readonly overlay: Extract<Overlay, { kind: "TEXT" | "SHAPE" }>;
  readonly textFilePath?: string | undefined;
  readonly fontFilePath?: string | undefined;
}): string {
  const { overlay } = input;
  const w = Math.round(overlay.width);
  const h = Math.round(overlay.height);
  if (overlay.kind === "TEXT") {
    if (!input.textFilePath || !input.fontFilePath)
      throw new Error("Text overlay requires a text file and font file");
    const parts = [
      `textfile=${input.textFilePath}`,
      `fontfile=${input.fontFilePath}`,
      `fontsize=${Math.round(overlay.fontSize)}`,
      `fontcolor=${ffmpegColor(overlay.color)}`,
      "x=0",
      "y=0",
    ];
    if (overlay.backgroundColor)
      parts.push("box=1", `boxcolor=${ffmpegColor(overlay.backgroundColor)}`);
    return `color=c=black@0.0:s=${w}x${h},drawtext=${parts.join(":")}`;
  }
  if (overlay.shape === "RECTANGLE") {
    return `color=c=black@0.0:s=${w}x${h},drawbox=x=0:y=0:w=${w}:h=${h}:color=${ffmpegColor(overlay.fillColor)}:t=fill,drawbox=x=0:y=0:w=${w}:h=${h}:color=${ffmpegColor(overlay.strokeColor)}:t=${Math.max(1, Math.round(overlay.strokeWidth))}`;
  }
  if (overlay.shape === "ELLIPSE") {
    const rx = (w / 2).toFixed(3);
    const ry = (h / 2).toFixed(3);
    const inside = `lte(pow((X-${rx})/${rx},2)+pow((Y-${ry})/${ry},2),1)`;
    return [
      `color=c=${ffmpegColor(overlay.fillColor)}:s=${w}x${h}`,
      "format=rgba",
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${inside},255,0)'`,
    ].join(",");
  }
  throw new Error(`No generated layer for shape ${overlay.shape}`);
}

/** Scales a decoded image/video asset input to an IMAGE overlay's WxH box. */
export function imageOverlayFilterChain(overlay: {
  readonly width: number;
  readonly height: number;
  readonly fit: "CONTAIN" | "COVER" | "FILL";
  readonly opacity: number;
}): string {
  const w = Math.round(overlay.width);
  const h = Math.round(overlay.height);
  const stages: string[] = [];
  if (overlay.fit === "FILL") stages.push(`scale=${w}:${h}`, "format=rgba");
  else if (overlay.fit === "COVER")
    stages.push(
      `scale=${w}:${h}:force_original_aspect_ratio=increase`,
      `crop=${w}:${h}`,
      "format=rgba",
    );
  else
    stages.push(
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      "format=rgba",
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`,
    );
  if (overlay.opacity !== 1) stages.push(`colorchannelmixer=aa=${overlay.opacity}`);
  return stages.join(",");
}
