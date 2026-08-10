import { describe, expect, it } from "vitest";
import {
  atempoChain,
  audioClipFilterChain,
  ffmpegColor,
  generatedOverlayFilterChain,
  imageOverlayFilterChain,
  piecewiseLinearExpr,
  videoClipFilterChain,
  zoomCropFilter,
} from "../src/filters";

describe("ffmpegColor", () => {
  it("converts a 6-digit hex color", () => {
    expect(ffmpegColor("#112233")).toBe("0x112233");
  });
  it("converts an 8-digit hex color with alpha", () => {
    expect(ffmpegColor("#11223380")).toBe("0x112233@0.502");
  });
});

describe("atempoChain", () => {
  it("emits a single stage within the 0.5-2.0 range", () => {
    expect(atempoChain(1.5)).toEqual(["atempo=1.500000"]);
  });
  it("chains stages for rates above 2.0", () => {
    const chain = atempoChain(4);
    expect(chain).toEqual(["atempo=2.0", "atempo=2.000000"]);
  });
  it("chains stages for rates below 0.5", () => {
    const chain = atempoChain(0.25);
    expect(chain).toEqual(["atempo=0.5", "atempo=0.500000"]);
  });
});

describe("piecewiseLinearExpr", () => {
  it("returns a constant for a single keyframe", () => {
    expect(
      piecewiseLinearExpr([{ timeMs: 0, scale: 2, x: 0, y: 0 }], (k) => k.scale),
    ).toBe("2.000000");
  });
  it("builds a boundary-gated linear interpolation for two keyframes", () => {
    const expr = piecewiseLinearExpr(
      [
        { timeMs: 0, scale: 1, x: 0, y: 0 },
        { timeMs: 2_000, scale: 3, x: 0, y: 0 },
      ],
      (k) => k.scale,
    );
    expect(expr).toContain("if(lt(t,2.000000)");
    expect(expr).toContain("1.000000+(3.000000-1.000000)*(t-0.000000)/2.000000");
  });
});

describe("zoomCropFilter", () => {
  it("produces a frame-evaluated crop expression", () => {
    const filter = zoomCropFilter([{ timeMs: 0, scale: 2, x: 0.5, y: 0.5 }]);
    expect(filter).toContain("crop=");
    expect(filter).toContain("eval=frame");
    expect(filter).toContain("iw/(2.000000)");
  });
});

const identityTransform = {
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
  rotationDegrees: 0,
  opacity: 1,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  zoomKeyframes: [],
};

describe("videoClipFilterChain", () => {
  it("scales and pads to fit the transform box without cropping/rotating", () => {
    const chain = videoClipFilterChain({ transform: identityTransform });
    expect(chain).toContain("scale=1280:720:force_original_aspect_ratio=decrease");
    expect(chain).toContain("pad=1280:720");
    expect(chain).not.toContain("rotate=");
    expect(chain).not.toContain("colorchannelmixer");
  });

  it("adds a static crop stage when crop fractions are set", () => {
    const chain = videoClipFilterChain({
      transform: { ...identityTransform, crop: { top: 0.1, right: 0, bottom: 0, left: 0.2 } },
    });
    expect(chain).toContain("iw*(1-0.2-0)");
    expect(chain).toContain("ih*(1-0.1-0)");
  });

  it("adds rotate and opacity stages", () => {
    const chain = videoClipFilterChain({
      transform: { ...identityTransform, rotationDegrees: 90, opacity: 0.5 },
    });
    expect(chain).toContain("rotate=");
    expect(chain).toContain("colorchannelmixer=aa=0.5");
  });
});

const audioSettings = {
  muted: false,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  noiseReduction: false,
  gainAutomation: [] as { timeMs: number; value: number }[],
};

describe("audioClipFilterChain", () => {
  it("returns undefined for a muted clip", () => {
    expect(audioClipFilterChain({ ...audioSettings, muted: true }, 5, 1)).toBeUndefined();
  });
  it("returns anull when there is nothing to apply", () => {
    expect(audioClipFilterChain(audioSettings, 5, 1)).toBe("anull");
  });
  it("applies gain, fades, and speed change", () => {
    const chain = audioClipFilterChain(
      { ...audioSettings, gainDb: -6, fadeInMs: 500, fadeOutMs: 250 },
      5,
      2,
    );
    expect(chain).toContain("atempo=2.000000");
    expect(chain).toContain("volume=-6dB");
    expect(chain).toContain("afade=t=in:st=0:d=0.500");
    expect(chain).toContain("afade=t=out:st=4.750:d=0.250");
  });
});

describe("generatedOverlayFilterChain", () => {
  it("builds a drawtext chain referencing the text and font files", () => {
    const chain = generatedOverlayFilterChain({
      overlay: {
        kind: "TEXT",
        text: "hello",
        color: "#FFFFFF",
        fontSize: 24,
        width: 100,
        height: 50,
      } as never,
      textFilePath: "/tmp/text.txt",
      fontFilePath: "/tmp/font.ttf",
    });
    expect(chain).toContain("textfile=/tmp/text.txt");
    expect(chain).toContain("fontfile=/tmp/font.ttf");
  });

  it("builds a filled-and-stroked rectangle", () => {
    const chain = generatedOverlayFilterChain({
      overlay: {
        kind: "SHAPE",
        shape: "RECTANGLE",
        fillColor: "#FF0000",
        strokeColor: "#00FF00",
        strokeWidth: 3,
        width: 100,
        height: 50,
      } as never,
    });
    expect(chain).toContain("t=fill");
    expect(chain).toContain(`color=${ffmpegColor("#FF0000")}`);
    expect(chain).toContain(`color=${ffmpegColor("#00FF00")}`);
  });

  it("builds an ellipse alpha mask preserving fill color", () => {
    const chain = generatedOverlayFilterChain({
      overlay: {
        kind: "SHAPE",
        shape: "ELLIPSE",
        fillColor: "#FF0000",
        strokeColor: "#00FF00",
        strokeWidth: 3,
        width: 100,
        height: 50,
      } as never,
    });
    expect(chain).toContain("geq=r='r(X,Y)'");
    expect(chain).toContain("lte(pow((X-50.000)/50.000,2)+pow((Y-25.000)/25.000,2),1)");
  });
});

describe("imageOverlayFilterChain", () => {
  it("letterboxes for CONTAIN with a transparent pad", () => {
    const chain = imageOverlayFilterChain({
      width: 100,
      height: 50,
      fit: "CONTAIN",
      opacity: 1,
      mask: "NONE",
    });
    expect(chain).toContain("force_original_aspect_ratio=decrease");
    expect(chain).toContain("pad=100:50");
  });
  it("crops for COVER", () => {
    const chain = imageOverlayFilterChain({
      width: 100,
      height: 50,
      fit: "COVER",
      opacity: 1,
      mask: "NONE",
    });
    expect(chain).toContain("force_original_aspect_ratio=increase");
    expect(chain).toContain("crop=100:50");
  });
  it("stretches for FILL and applies opacity", () => {
    const chain = imageOverlayFilterChain({
      width: 100,
      height: 50,
      fit: "FILL",
      opacity: 0.5,
      mask: "NONE",
    });
    expect(chain).toContain("scale=100:50");
    expect(chain).toContain("colorchannelmixer=aa=0.5");
  });
  it("applies no mask filter for NONE", () => {
    const chain = imageOverlayFilterChain({
      width: 200,
      height: 200,
      fit: "COVER",
      opacity: 1,
      mask: "NONE",
    });
    expect(chain).not.toContain("geq=");
  });
  it("masks a camera overlay to a circle, preserving color and existing alpha", () => {
    const chain = imageOverlayFilterChain({
      width: 200,
      height: 200,
      fit: "COVER",
      opacity: 1,
      mask: "CIRCLE",
    });
    expect(chain).toContain("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'");
    expect(chain).toContain("lte(pow((X-100.000)/100.000,2)+pow((Y-100.000)/100.000,2),1)");
    expect(chain).toContain("a(X,Y)");
  });
  it("masks to rounded corners with a balanced expression", () => {
    const chain = imageOverlayFilterChain({
      width: 200,
      height: 100,
      fit: "COVER",
      opacity: 1,
      mask: "ROUNDED_RECT",
    });
    const opens = chain.match(/\(/g)?.length ?? 0;
    const closes = chain.match(/\)/g)?.length ?? 0;
    expect(opens).toBe(closes);
    expect(chain).toContain("geq=");
  });
});
