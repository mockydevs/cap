import { requireActor } from "../../../../../lib/auth/authorization";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";
import { transcriptError } from "../../../../../lib/transcripts/http";
import {
  renderCaptions,
  renderTranslatedCaptions,
} from "../../../../../lib/transcripts/service";
import { transcriptLanguageSchema } from "../../../../../lib/transcripts/validation";
import { z } from "zod";

const captionsQuerySchema = z.object({
  format: z.enum(["vtt", "srt"]).default("vtt"),
  language: transcriptLanguageSchema.optional(),
});
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request);
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const { format, language } = captionsQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const content = language
      ? await renderTranslatedCaptions(recordingId, actor, language, format)
      : await renderCaptions(recordingId, actor, format);
    return new Response(content, {
      headers: {
        "content-type":
          format === "vtt"
            ? "text/vtt; charset=utf-8"
            : "application/x-subrip; charset=utf-8",
        "content-disposition": `inline; filename="recording-${recordingId}${language ? `.${language}` : ""}.${format}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return transcriptError(error);
  }
}
