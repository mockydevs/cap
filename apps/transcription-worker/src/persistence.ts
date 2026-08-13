import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CanonicalSegment,
  CanonicalTranscriptSnapshot,
  MergedProviderRun,
  TranscriptPersistence,
} from "@cap/transcription";

type SegmentRow = {
  id: string;
  start_ms: string;
  end_ms: string;
  provider_text: string;
  corrected_text: string | null;
  provider_speaker_label: string | null;
  corrected_speaker_label: string | null;
  confidence: string | null;
  is_orphaned: boolean;
};
type WordRow = {
  id: string;
  segment_id: string;
  start_ms: string;
  end_ms: string;
  provider_text: string;
  corrected_text: string | null;
  confidence: string | null;
  is_orphaned: boolean;
};
export class PostgresTranscriptPersistence implements TranscriptPersistence<PoolClient> {
  constructor(private readonly pool: Pool) {}
  async loadCanonical(
    transcriptId: string,
  ): Promise<CanonicalTranscriptSnapshot> {
    const transcript = await this.pool.query<{ correction_revision: number }>(
      "SELECT correction_revision FROM transcripts WHERE id=$1",
      [transcriptId],
    );
    if (!transcript.rows[0]) throw new Error("Transcript not found");
    const segments = await this.pool.query<SegmentRow>(
      "SELECT * FROM transcript_segments WHERE transcript_id=$1 ORDER BY ordinal",
      [transcriptId],
    );
    const words = segments.rowCount
      ? await this.pool.query<WordRow>(
          "SELECT w.* FROM transcript_words w JOIN transcript_segments s ON s.id=w.segment_id WHERE s.transcript_id=$1 ORDER BY w.ordinal",
          [transcriptId],
        )
      : { rows: [] as WordRow[] };
    return {
      transcriptId,
      correctionRevision: transcript.rows[0].correction_revision,
      segments: segments.rows.map((segment) => ({
        id: segment.id,
        startMs: Number(segment.start_ms),
        endMs: Number(segment.end_ms),
        providerText: segment.provider_text,
        ...(segment.corrected_text === null
          ? {}
          : { correctedText: segment.corrected_text }),
        ...(segment.provider_speaker_label === null
          ? {}
          : { providerSpeakerLabel: segment.provider_speaker_label }),
        ...(segment.corrected_speaker_label === null
          ? {}
          : { correctedSpeakerLabel: segment.corrected_speaker_label }),
        ...(segment.confidence === null
          ? {}
          : { confidence: Number(segment.confidence) }),
        isOrphaned: segment.is_orphaned,
        words: words.rows
          .filter((word) => word.segment_id === segment.id)
          .map((word) => ({
            id: word.id,
            startMs: Number(word.start_ms),
            endMs: Number(word.end_ms),
            providerText: word.provider_text,
            ...(word.corrected_text === null
              ? {}
              : { correctedText: word.corrected_text }),
            ...(word.confidence === null
              ? {}
              : { confidence: Number(word.confidence) }),
            isOrphaned: word.is_orphaned,
          })),
      })),
    };
  }
  /**
   * `onCommit` runs inside the same transaction as the run it belongs to,
   * immediately before COMMIT. The caller uses it to append the usage ledger
   * entry, so metered spend and a recorded transcription can never disagree.
   */
  async commitMergedProviderRun(
    command: MergedProviderRun,
    onCommit?: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ correction_revision: number }>(
        "SELECT correction_revision FROM transcripts WHERE id=$1 FOR UPDATE",
        [command.transcriptId],
      );
      if (
        locked.rows[0]?.correction_revision !==
        command.expectedCorrectionRevision
      )
        throw new Error("TRANSCRIPT_CORRECTION_CONFLICT");
      const existing = await client.query(
        "SELECT status FROM transcription_runs WHERE transcript_id=$1 AND attempt=$2",
        [command.transcriptId, command.provenance.attempt],
      );
      if (existing.rows[0]?.status === "SUCCEEDED") {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        "INSERT INTO transcription_runs (id,transcript_id,attempt,status,provider,model,provider_request_id_hash,requested_language,detected_language,identify_speakers,consent_basis,consent_captured_at,consent_actor_user_id,billed_duration_ms,cost_microunits,currency,data_region,started_at,completed_at) VALUES ($1,$2,$3,'SUCCEEDED',$4,$5,$6,NULL,$7,false,$8,$9,$10,$11,$12,$13,$14,$9,now())",
        [
          command.provenance.runId,
          command.transcriptId,
          command.provenance.attempt,
          command.providerResult.provider,
          command.providerResult.model,
          command.providerResult.providerRequestId
            ? createHash("sha256")
                .update(command.providerResult.providerRequestId)
                .digest("hex")
            : null,
          command.providerResult.language,
          command.provenance.consentBasis,
          command.provenance.consentCapturedAt,
          command.provenance.consentActorUserId ?? null,
          command.providerResult.billedDurationMs ?? null,
          command.providerResult.costMicrounits ?? null,
          command.providerResult.currency ?? null,
          command.providerResult.dataRegion ?? null,
        ],
      );
      const sources = new Map<
        string,
        { segmentId: string; words: Map<string, string> }
      >();
      for (const [
        ordinal,
        segment,
      ] of command.providerResult.segments.entries()) {
        const segmentId = randomUUID();
        await client.query(
          "INSERT INTO transcript_run_segments (id,run_id,provider_key,ordinal,start_ms,end_ms,text,speaker_label,confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            segmentId,
            command.provenance.runId,
            segment.providerKey,
            ordinal,
            segment.startMs,
            segment.endMs,
            segment.text,
            segment.speakerLabel ?? null,
            segment.confidence ?? null,
          ],
        );
        const wordIds = new Map<string, string>();
        for (const [wordOrdinal, word] of segment.words.entries()) {
          const wordId = randomUUID();
          wordIds.set(word.providerKey, wordId);
          await client.query(
            "INSERT INTO transcript_run_words (id,run_segment_id,provider_key,ordinal,start_ms,end_ms,text,confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              wordId,
              segmentId,
              word.providerKey,
              wordOrdinal,
              word.startMs,
              word.endMs,
              word.text,
              word.confidence ?? null,
            ],
          );
        }
        sources.set(segment.providerKey, { segmentId, words: wordIds });
      }
      await this.persistCanonical(client, command, sources);
      await client.query(
        "UPDATE transcripts SET status='READY', approved_language=$2, updated_at=now() WHERE id=$1",
        [command.transcriptId, command.providerResult.language],
      );
      await client.query(
        `INSERT INTO webhook_outbox (event, workspace_id, aggregate_id, payload)
         SELECT 'transcript.ready', t.workspace_id, t.recording_id,
                jsonb_build_object('transcriptId', t.id, 'recordingId', t.recording_id)
         FROM transcripts t WHERE t.id = $1`,
        [command.transcriptId],
      );
      if (onCommit) await onCommit(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async persistCanonical(
    client: PoolClient,
    command: MergedProviderRun,
    sources: Map<string, { segmentId: string; words: Map<string, string> }>,
  ) {
    const kept = command.canonicalSegments.map((item) => item.id);
    await client.query(
      "DELETE FROM transcript_segments WHERE transcript_id=$1 AND corrected_text IS NULL AND corrected_speaker_label IS NULL AND NOT (id=ANY($2::uuid[]))",
      [command.transcriptId, kept],
    );
    for (const [ordinal, segment] of command.canonicalSegments.entries()) {
      const provider = command.providerResult.segments.find(
        (item) =>
          !segment.isOrphaned &&
          item.startMs === segment.startMs &&
          item.endMs === segment.endMs &&
          item.text === segment.providerText,
      );
      const source = provider ? sources.get(provider.providerKey) : undefined;
      await client.query(
        "INSERT INTO transcript_segments (id,transcript_id,source_run_segment_id,ordinal,start_ms,end_ms,provider_text,provider_speaker_label,confidence,is_orphaned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET source_run_segment_id=EXCLUDED.source_run_segment_id,ordinal=EXCLUDED.ordinal,start_ms=EXCLUDED.start_ms,end_ms=EXCLUDED.end_ms,provider_text=EXCLUDED.provider_text,provider_speaker_label=EXCLUDED.provider_speaker_label,confidence=EXCLUDED.confidence,is_orphaned=EXCLUDED.is_orphaned",
        [
          segment.id,
          command.transcriptId,
          source?.segmentId ?? null,
          ordinal,
          segment.startMs,
          segment.endMs,
          segment.providerText,
          segment.providerSpeakerLabel ?? null,
          segment.confidence ?? null,
          segment.isOrphaned,
        ],
      );
      const keptWords = segment.words.map((item) => item.id);
      await client.query(
        "DELETE FROM transcript_words WHERE segment_id=$1 AND corrected_text IS NULL AND NOT (id=ANY($2::uuid[]))",
        [segment.id, keptWords],
      );
      for (const [wordOrdinal, word] of segment.words.entries()) {
        const providerWord = provider?.words.find(
          (item) =>
            !word.isOrphaned &&
            item.startMs === word.startMs &&
            item.endMs === word.endMs &&
            item.text === word.providerText,
        );
        await client.query(
          "INSERT INTO transcript_words (id,segment_id,source_run_word_id,ordinal,start_ms,end_ms,provider_text,confidence,is_orphaned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET source_run_word_id=EXCLUDED.source_run_word_id,ordinal=EXCLUDED.ordinal,start_ms=EXCLUDED.start_ms,end_ms=EXCLUDED.end_ms,provider_text=EXCLUDED.provider_text,confidence=EXCLUDED.confidence,is_orphaned=EXCLUDED.is_orphaned",
          [
            word.id,
            segment.id,
            providerWord
              ? (source?.words.get(providerWord.providerKey) ?? null)
              : null,
            wordOrdinal,
            word.startMs,
            word.endMs,
            word.providerText,
            word.confidence ?? null,
            word.isOrphaned,
          ],
        );
      }
    }
  }
  async applySegmentCorrection(command: {
    transcriptId: string;
    segmentId: string;
    expectedSegmentCorrectionVersion: number;
    expectedTranscriptCorrectionRevision: number;
    correctedText?: string;
    correctedSpeakerLabel?: string;
    correctedBy: string;
    correctedAt: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const segment = await client.query(
        "UPDATE transcript_segments SET corrected_text=$5,corrected_speaker_label=$6,corrected_by=$7,corrected_at=$8,correction_version=correction_version+1 WHERE id=$1 AND transcript_id=$2 AND correction_version=$3 AND EXISTS (SELECT 1 FROM transcripts WHERE id=$2 AND correction_revision=$4) RETURNING id",
        [
          command.segmentId,
          command.transcriptId,
          command.expectedSegmentCorrectionVersion,
          command.expectedTranscriptCorrectionRevision,
          command.correctedText ?? null,
          command.correctedSpeakerLabel ?? null,
          command.correctedBy,
          command.correctedAt,
        ],
      );
      if (segment.rowCount !== 1)
        throw new Error("TRANSCRIPT_CORRECTION_CONFLICT");
      await client.query(
        "UPDATE transcripts SET correction_revision=correction_revision+1,updated_at=now() WHERE id=$1 AND correction_revision=$2",
        [command.transcriptId, command.expectedTranscriptCorrectionRevision],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
