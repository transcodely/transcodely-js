/**
 * Type-level tests for the OutputReport re-exports (Horizon S4).
 *
 * `JobOutput.report` is only reachable from the package root if index.ts
 * re-exports OutputReport and each of its nested messages. These assertions
 * pin that: they import the report types from `src/index.js` (the facade) and
 * compare them against the generated types, so dropping a re-export — or
 * letting one drift onto a different shape — is a compile error.
 *
 * Enforced by `pnpm typecheck` (tsconfig.typecheck.json includes this
 * directory). NOT executed by vitest: the `.test-d.ts` suffix falls outside
 * vitest's default include glob. Keep every assertion type-only.
 */
import * as gen from "../../src/gen/transcodely/v1/job_pb.js";
import type {
  JobOutput,
  OutputReport,
  OutputReportAudio,
  OutputReportColor,
  OutputReportContentAware,
  OutputReportContentAwareProbe,
  OutputReportMismatch,
  OutputReportVerdict,
  OutputReportVideo,
} from "../../src/index.js";

/** Compile error unless `A` and `B` are the *exact* same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<_Pass extends true>(): void {}

// (1) Each facade re-export is the generated message itself, not a look-alike.
expectType<Equal<OutputReport, gen.OutputReport>>();
expectType<Equal<OutputReportVideo, gen.OutputReportVideo>>();
expectType<Equal<OutputReportColor, gen.OutputReportColor>>();
expectType<Equal<OutputReportAudio, gen.OutputReportAudio>>();
expectType<Equal<OutputReportVerdict, gen.OutputReportVerdict>>();
expectType<Equal<OutputReportMismatch, gen.OutputReportMismatch>>();
expectType<Equal<OutputReportContentAware, gen.OutputReportContentAware>>();
expectType<Equal<OutputReportContentAwareProbe, gen.OutputReportContentAwareProbe>>();

// (2) The report hangs off a job output, and is optional there — "not
//     measured" stays distinguishable from "measured, nothing wrong".
expectType<Equal<JobOutput["report"], OutputReport | undefined>>();

// (3) The whole report tree is reachable from the facade types alone, with no
//     deep import: a caller can walk output.report.verdict.mismatches[n].field
//     and output.report.video.color without naming a generated path.
declare const output: JobOutput;
if (output.report) {
  expectType<Equal<typeof output.report.container, string>>();
  expectType<Equal<typeof output.report.video, OutputReportVideo | undefined>>();
  expectType<Equal<typeof output.report.audio, OutputReportAudio[]>>();
  expectType<Equal<typeof output.report.durationSeconds, number | undefined>>();
  expectType<Equal<typeof output.report.verdict, OutputReportVerdict | undefined>>();

  if (output.report.verdict) {
    expectType<Equal<typeof output.report.verdict.matchesRequest, boolean>>();
    expectType<Equal<typeof output.report.verdict.mismatches, OutputReportMismatch[]>>();
  }
  if (output.report.video) {
    expectType<Equal<typeof output.report.video.codec, string>>();
    expectType<Equal<typeof output.report.video.hdrFormat, string>>();
    expectType<Equal<typeof output.report.video.color, OutputReportColor | undefined>>();
  }

  // (4) The per-title search result is optional on the report — absent on
  //     every ordinary output, and on a content-aware output whose analysis
  //     never reported.
  expectType<
    Equal<typeof output.report.contentAware, OutputReportContentAware | undefined>
  >();
  if (output.report.contentAware) {
    expectType<Equal<typeof output.report.contentAware.mode, string>>();
    expectType<Equal<typeof output.report.contentAware.vmafTarget, number | undefined>>();
    expectType<Equal<typeof output.report.contentAware.vmafAchieved, number | undefined>>();
    expectType<Equal<typeof output.report.contentAware.crfChosen, number | undefined>>();
    expectType<Equal<typeof output.report.contentAware.seedCrf, number | undefined>>();
    expectType<Equal<typeof output.report.contentAware.metTarget, boolean | undefined>>();
    expectType<
      Equal<typeof output.report.contentAware.probes, OutputReportContentAwareProbe[]>
    >();
    const probe = output.report.contentAware.probes[0];
    if (probe) {
      expectType<Equal<typeof probe.crf, number>>();
      expectType<Equal<typeof probe.vmaf, number>>();
      expectType<Equal<typeof probe.bitrateKbps, number | undefined>>();
    }
  }
}
