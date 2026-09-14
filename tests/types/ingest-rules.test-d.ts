/**
 * Type-level tests for the IngestRuleService re-exports (Horizon S5).
 *
 * The ingest types are only reachable from the package root if index.ts
 * re-exports them. These assertions pin that: they import from `src/index.js`
 * (the facade) and compare against the generated types, so dropping a
 * re-export — or letting one drift onto a different shape — is a compile
 * error.
 *
 * Enforced by `pnpm typecheck` (tsconfig.typecheck.json includes this
 * directory). NOT executed by vitest: the `.test-d.ts` suffix falls outside
 * vitest's default include glob. Keep every assertion type-only.
 */
import * as gen from "../../src/gen/transcodely/v1/ingest_rule_pb.js";
import type { Transcodely } from "../../src/index.js";
import type {
  CreateIngestRuleRequest,
  CreateIngestRuleResponse,
  DeleteIngestRuleRequest,
  DeleteIngestRuleResponse,
  GetIngestRuleRequest,
  GetIngestRuleResponse,
  IngestRule,
  IngestRuleAction,
  IngestRuleFilters,
  ListIngestEventsRequest,
  ListIngestEventsResponse,
  ListIngestRulesRequest,
  ListIngestRulesResponse,
  ReplayIngestEventRequest,
  ReplayIngestEventResponse,
  StorageEvent,
  TestIngestRuleRequest,
  TestIngestRuleResponse,
  UpdateIngestRuleRequest,
  UpdateIngestRuleResponse,
} from "../../src/index.js";
import { StorageEventSource, StorageEventStatus } from "../../src/index.js";

/** Compile error unless `A` and `B` are the *exact* same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<_Pass extends true>(): void {}

// (1) Each facade re-export is the generated message itself, not a look-alike.
expectType<Equal<IngestRule, gen.IngestRule>>();
expectType<Equal<IngestRuleFilters, gen.IngestRuleFilters>>();
expectType<Equal<IngestRuleAction, gen.IngestRuleAction>>();
expectType<Equal<StorageEvent, gen.StorageEvent>>();
expectType<Equal<CreateIngestRuleRequest, gen.CreateIngestRuleRequest>>();
expectType<Equal<CreateIngestRuleResponse, gen.CreateIngestRuleResponse>>();
expectType<Equal<GetIngestRuleRequest, gen.GetIngestRuleRequest>>();
expectType<Equal<GetIngestRuleResponse, gen.GetIngestRuleResponse>>();
expectType<Equal<ListIngestRulesRequest, gen.ListIngestRulesRequest>>();
expectType<Equal<ListIngestRulesResponse, gen.ListIngestRulesResponse>>();
expectType<Equal<UpdateIngestRuleRequest, gen.UpdateIngestRuleRequest>>();
expectType<Equal<UpdateIngestRuleResponse, gen.UpdateIngestRuleResponse>>();
expectType<Equal<DeleteIngestRuleRequest, gen.DeleteIngestRuleRequest>>();
expectType<Equal<DeleteIngestRuleResponse, gen.DeleteIngestRuleResponse>>();
expectType<Equal<ListIngestEventsRequest, gen.ListIngestEventsRequest>>();
expectType<Equal<ListIngestEventsResponse, gen.ListIngestEventsResponse>>();
expectType<Equal<TestIngestRuleRequest, gen.TestIngestRuleRequest>>();
expectType<Equal<TestIngestRuleResponse, gen.TestIngestRuleResponse>>();
expectType<Equal<ReplayIngestEventRequest, gen.ReplayIngestEventRequest>>();
expectType<Equal<ReplayIngestEventResponse, gen.ReplayIngestEventResponse>>();

// (2) The two enums are re-exported as VALUES, not just types — a caller must
//     be able to write StorageEventStatus.SKIPPED.
expectType<Equal<typeof StorageEventSource, typeof gen.StorageEventSource>>();
expectType<Equal<typeof StorageEventStatus, typeof gen.StorageEventStatus>>();
const _skipped: StorageEventStatus = StorageEventStatus.SKIPPED;
const _s3: StorageEventSource = StorageEventSource.S3_SNS;
void _skipped;
void _s3;

// (3) The namespace hangs off the root client, and create resolves to the
//     whole response — the reveal-once secret must stay reachable.
type IngestNamespace = Transcodely["ingestRules"];
expectType<Equal<Awaited<ReturnType<IngestNamespace["create"]>>, gen.CreateIngestRuleResponse>>();
expectType<Equal<Awaited<ReturnType<IngestNamespace["update"]>>, gen.UpdateIngestRuleResponse>>();
expectType<Equal<Awaited<ReturnType<IngestNamespace["get"]>>, gen.IngestRule>>();
expectType<Equal<Awaited<ReturnType<IngestNamespace["replayEvent"]>>, gen.StorageEvent>>();

// (4) An unmeasured optional stays distinguishable from an empty one.
expectType<Equal<IngestRule["filters"], gen.IngestRuleFilters | undefined>>();
expectType<Equal<IngestRule["action"], gen.IngestRuleAction | undefined>>();
