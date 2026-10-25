import { describe, expect, it } from "vitest";

import { fromJson, toWireJson } from "../../src/codec/json.js";
import { Job } from "../../src/gen/transcodely/v1/job_pb.js";
import {
  InsightsStatus,
  SubtitleOperation,
  SubtitleResult,
  SubtitleTrack,
  TranscriptFormat,
  TranscriptStyle,
} from "../../src/gen/transcodely/v1/subtitles_pb.js";

describe("transcripts and insights on the wire", () => {
  it("decodes job insights with lowercase status and nested sections", () => {
    const job = fromJson(
      {
        id: "job_a1b2c3d4e5f6",
        insights: [
          {
            output_id: "out_a1b2c3d4e5f6g7",
            language: "eng",
            status: "ready",
            summary: "A short talk.",
            key_points: ["one", "two"],
            questions: [{ question: "Why?", answer: "Because.", start_seconds: 12.5 }],
            terms: [{ term: "GOP", definition: "Group of pictures.", start_seconds: 3 }],
            highlights: [{ text: "verbatim", start_seconds: 1, end_seconds: 2.5 }],
            chapters: [{ start_seconds: 0, title: "Intro" }],
            generated_at: "2026-10-24T10:00:00Z",
          },
        ],
      },
      Job,
    );
    const ins = job.insights[0];
    expect(ins.status).toBe(InsightsStatus.READY);
    expect(ins.keyPoints).toEqual(["one", "two"]);
    expect(ins.questions[0].startSeconds).toBe(12.5);
    expect(ins.terms[0].term).toBe("GOP");
    expect(ins.highlights[0].endSeconds).toBe(2.5);
    expect(ins.chapters[0].title).toBe("Intro");
    expect(ins.generatedAt).toBeDefined();
  });

  it("decodes transcript renditions and style on a subtitle result", () => {
    const res = fromJson(
      {
        transcript_style: "literal",
        transcript_renditions: [
          { format: "json", storage_key: "a/t.json", url: "gs://b/a/t.json" },
          { format: "txt", storage_key: "a/t.txt", url: "gs://b/a/t.txt", signed_url: "https://x/t.txt" },
          { format: "md", storage_key: "a/t.md", url: "gs://b/a/t.md" },
        ],
      },
      SubtitleResult,
    );
    expect(res.transcriptStyle).toBe(TranscriptStyle.LITERAL);
    expect(res.transcriptRenditions.map((r) => r.format)).toEqual([
      TranscriptFormat.JSON,
      TranscriptFormat.TXT,
      TranscriptFormat.MD,
    ]);
    expect(res.transcriptRenditions[1].signedUrl).toBe("https://x/t.txt");
  });

  it("encodes transcript and insights options as snake_case with lowercase style", () => {
    const track = new SubtitleTrack({
      operation: SubtitleOperation.GENERATE,
      transcript: { style: TranscriptStyle.CLEAN },
      insights: { enabled: true, hint: "lecture for first-year students" },
    });
    const json = toWireJson(track, { emitDefaultValues: false }) as Record<string, unknown>;
    expect(json.operation).toBe("generate");
    expect(json.transcript).toEqual({ style: "clean" });
    expect(json.insights).toEqual({ enabled: true, hint: "lecture for first-year students" });
  });
});
