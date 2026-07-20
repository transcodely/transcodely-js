/**
 * @transcodely/sdk — Official TypeScript SDK for the Transcodely video
 * transcoding API.
 *
 * @example
 * ```ts
 * import { Transcodely, OutputFormat, VideoCodec, Resolution } from "@transcodely/sdk";
 * const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });
 * const job = await client.jobs.create({
 *   inputUrl: "s3://my-bucket/source.mp4",
 *   outputs: [{
 *     type: OutputFormat.HLS,
 *     video: [{ codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_1080P }],
 *   }],
 * });
 * ```
 */

export { Transcodely, type TranscodelyConfig } from "./client.js";

export {
  APIConnectionError,
  APIError,
  AuthenticationError,
  ConflictError,
  type FieldViolation,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
  PreconditionError,
  RateLimitError,
  TranscodelyError,
  WebhookError,
  WebhookPayloadError,
  WebhookSignatureError,
  WebhookTimestampError,
} from "./errors.js";

export type { CallOptions, LogEvent } from "./transport/transport.js";

export { Page } from "./pagination.js";

export { API_VERSION, SDK_VERSION, DEFAULT_BASE_URL } from "./version.js";

// ----------------------------------------------------------------------------
// Generated message types and enums.
//
// Every public proto type is re-exported here so callers stay in
// `transcodely` and never have to deep-import generated paths.
// ----------------------------------------------------------------------------

// Pagination + envelope.
export {
  type PaginationRequest,
  type PaginationResponse,
  type ErrorDetails,
  // Codec / format / quality enums shared across messages.
  VideoCodec,
  AudioCodec,
  Container,
  Resolution,
  QualityTier,
  OutputFormat,
  ContentType,
  DeliveryFormat,
  BitrateMode,
} from "./gen/transcodely/v1/common_pb.js";

// Jobs.
export {
  type Job,
  type JobOutput,
  type OutputVariantResult,
  type OutputSpec,
  type VideoVariant,
  type AudioTrackConfig,
  type HLSConfig,
  type DASHConfig,
  type SegmentConfig,
  type ClipConfig,
  type ExecutionTiming,
  type PricingSnapshot,
  type VariantPricingSnapshot,
  type JobFee,
  type CreateJobRequest,
  type CreateJobResponse,
  type GetJobRequest,
  type GetJobResponse,
  type ListJobsRequest,
  type ListJobsResponse,
  type CancelJobRequest,
  type CancelJobResponse,
  type ConfirmJobRequest,
  type ConfirmJobResponse,
  type WatchJobRequest,
  type WatchJobResponse,
  JobStatus,
  JobPriority,
  OutputStatus,
  WatchEventType,
} from "./gen/transcodely/v1/job_pb.js";

// Videos.
export {
  type Video,
  type VideoRendition,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  type CreateFromUrlRequest,
  type CreateFromUrlResponse,
  type UploadPart,
  type CompletedPart,
  type CreateMultipartUploadRequest,
  type CreateMultipartUploadResponse,
  type GetUploadPartUrlsRequest,
  type GetUploadPartUrlsResponse,
  type CompleteMultipartUploadRequest,
  type CompleteMultipartUploadResponse,
  type AbortMultipartUploadRequest,
  type GetVideoRequest,
  type GetVideoResponse,
  type ListVideosRequest,
  type ListVideosResponse,
  type UpdateVideoRequest,
  type UpdateVideoResponse,
  type DeleteVideoRequest,
  type WatchVideoRequest,
  type WatchVideoResponse,
  type GetUsageRequest,
  type GetUsageResponse,
  type UsageSummary,
  type DailyUsage,
  type GetStatsRequest,
  type GetStatsResponse,
  type VideoStatsDay,
  type VideoStatsTotals,
  type ListTopVideosRequest,
  type ListTopVideosResponse,
  type TopVideo,
  VideoStatus,
  VideoVisibility,
} from "./gen/transcodely/v1/video_pb.js";

// Presets.
export {
  type Preset,
  type PresetVariant,
  type VideoSettings,
  type AudioSettings,
  type CreatePresetRequest,
  type CreatePresetResponse,
  type GetPresetRequest,
  type GetPresetResponse,
  type GetPresetBySlugRequest,
  type GetPresetBySlugResponse,
  type ListPresetsRequest,
  type ListPresetsResponse,
  type UpdatePresetRequest,
  type UpdatePresetResponse,
  type DuplicatePresetRequest,
  type DuplicatePresetResponse,
  type ArchivePresetRequest,
} from "./gen/transcodely/v1/preset_pb.js";

// Origins.
export {
  type Origin,
  type OriginRef,
  type GcsCredentials,
  type S3Credentials,
  type HttpCredentials,
  type GcsOriginConfig,
  type S3OriginConfig,
  type HttpOriginConfig,
  type R2OriginConfig,
  type ValidationResult,
  type CreateOriginRequest,
  type CreateOriginResponse,
  type GetOriginRequest,
  type GetOriginResponse,
  type ListOriginsRequest,
  type ListOriginsResponse,
  type UpdateOriginRequest,
  type UpdateOriginResponse,
  type ValidateOriginRequest,
  type ValidateOriginResponse,
  type ArchiveOriginRequest,
  OriginProvider,
  OriginPermission,
  OriginStatus,
  R2Jurisdiction,
} from "./gen/transcodely/v1/origin_pb.js";

// Apps.
export {
  type App,
  type HostingConfig,
  type AutoProfileDefaults,
  type CreateAppRequest,
  type CreateAppResponse,
  type GetAppRequest,
  type GetAppResponse,
  type UpdateAppRequest,
  type UpdateAppResponse,
  type ListAppsRequest,
  type ListAppsResponse,
  type ArchiveAppRequest,
  type EnableHostingRequest,
  type EnableHostingResponse,
  type UpdateHostingConfigRequest,
  type UpdateHostingConfigResponse,
  type UpdateSpendLimitRequest,
  type UpdateSpendLimitResponse,
  type GetSpendRequest,
  type GetSpendResponse,
  AppStatus,
} from "./gen/transcodely/v1/app_pb.js";

// Webhooks. The proto-level `Event` is re-exported as `APIEvent` to keep
// the customer-facing discriminated union `WebhookEvent` (in ./webhooks)
// as the primary `Event` type developers reach for.
export {
  type Event as APIEvent,
  type WebhookEndpoint,
  type WebhookDelivery,
  type CreateWebhookEndpointRequest,
  type CreateWebhookEndpointResponse,
  type RetrieveWebhookEndpointRequest,
  type RetrieveWebhookEndpointResponse,
  type UpdateWebhookEndpointRequest,
  type UpdateWebhookEndpointResponse,
  type DeleteWebhookEndpointRequest,
  type DeleteWebhookEndpointResponse,
  type ListWebhookEndpointsRequest,
  type ListWebhookEndpointsResponse,
  type RotateWebhookSecretRequest,
  type RotateWebhookSecretResponse,
  type ListEventsRequest,
  type ListEventsResponse,
  type RetrieveEventRequest,
  type RetrieveEventResponse,
  type ResendEventRequest,
  type ResendEventResponse,
  type ListWebhookDeliveriesRequest,
  type ListWebhookDeliveriesResponse,
  type SendTestWebhookRequest,
  type SendTestWebhookResponse,
  type GetEndpointHealthRequest,
  type GetEndpointHealthResponse,
  type HealthBucket,
  type EndpointHealthSummary,
} from "./gen/transcodely/v1/webhook_pb.js";

export {
  Webhooks,
  constructEvent,
  verifySignature,
  DEFAULT_TOLERANCE_SECONDS,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  WEBHOOK_EVENT_TYPES,
  type EventBase,
  type SpendLimitNotification,
  type WebhookEvent,
  type WebhookEventType,
  type VerifyOptions,
} from "./webhooks/index.js";

// API keys.
export {
  type APIKey,
  type CreateAPIKeyRequest,
  type CreateAPIKeyResponse,
  type GetAPIKeyRequest,
  type GetAPIKeyResponse,
  type ListAPIKeysRequest,
  type ListAPIKeysResponse,
  type RevokeAPIKeyRequest,
} from "./gen/transcodely/v1/api_key_pb.js";

// Organizations.
export {
  type Organization,
  type CheckSlugRequest,
  type CheckSlugResponse,
  type CreateOrganizationRequest,
  type CreateOrganizationResponse,
  type GetOrganizationRequest,
  type GetOrganizationResponse,
  type UpdateOrganizationRequest,
  type UpdateOrganizationResponse,
  type ListOrganizationsRequest,
  type ListOrganizationsResponse,
  OrganizationStatus,
} from "./gen/transcodely/v1/organization_pb.js";

// Memberships.
export {
  type Membership,
  type MembershipWithUser,
  type GetMembershipRequest,
  type GetMembershipResponse,
  type ListMembershipsRequest,
  type ListMembershipsResponse,
  type UpdateMembershipRoleRequest,
  type UpdateMembershipRoleResponse,
  type RemoveMembershipRequest,
  MembershipRole,
  MembershipStatus,
} from "./gen/transcodely/v1/membership_pb.js";

// Users.
export {
  type User,
  type UserWithOrganizations,
  type UserOrganization,
  type GetMeRequest,
  type GetMeResponse,
  type GetUserRequest,
  type GetUserResponse,
  type UpdateMeRequest,
  type UpdateMeResponse,
  type ListUsersRequest,
  type ListUsersResponse,
  UserStatus,
  UserApprovalStatus,
} from "./gen/transcodely/v1/user_pb.js";

// ----------------------------------------------------------------------------
// Feature configuration messages and their enums.
// These ride inside an OutputSpec / PresetVariant on a job creation request.
// ----------------------------------------------------------------------------

export {
  type DRMConfig,
  type BYOKConfig,
  type KeyServerConfig,
  DRMSystem,
  EncryptionScheme,
} from "./gen/transcodely/v1/drm_pb.js";

export {
  type HDRConfig,
  HDRFormat,
  HDRMode,
  ToneMapping,
} from "./gen/transcodely/v1/hdr_pb.js";

// Content-aware encoding is currently unavailable. The API rejects any job
// create request that sets `content_aware` (per-title or auto-ABR) on an output
// with InvalidArgument — rule `parameter_unsupported` on
// `outputs[i].content_aware` — until worker support ships. These types stay
// exported for forward compatibility. See
// https://github.com/transcodely/api/issues/167.
export {
  type ContentAwareConfig,
  type AutoABRConfig,
  type ContentAnalysis,
  ContentAwareMode,
} from "./gen/transcodely/v1/content_aware_pb.js";

export {
  type SubtitleTrack,
  type SubtitleResult,
  type BurnInStyle,
  SubtitleOperation,
  SubtitleFormat,
} from "./gen/transcodely/v1/subtitles_pb.js";

// ChapterPoint / ChapterResult carry the opt-in auto-chapters pass over
// generated captions (SubtitleTrack.generateChapters). Not yet populated:
// auto-chapters is rolling out together with the `generate` subtitle
// operation. Exported ahead of the rollout so consumers can code against the
// shape now.
export {
  type ChapterPoint,
  type ChapterResult,
} from "./gen/transcodely/v1/subtitles_pb.js";

export {
  type WatermarkConfig,
  type WatermarkPixelPlacement,
  WatermarkAnchor,
} from "./gen/transcodely/v1/watermark_pb.js";

export {
  type ThumbnailSpec,
  type ThumbnailResult,
  ThumbnailMode,
  ThumbnailFormat,
} from "./gen/transcodely/v1/thumbnails_pb.js";

export {
  type StreamingConfig,
  HLSSegmentFormat,
  HLSPlaylistType,
  GOPAlignmentMode,
} from "./gen/transcodely/v1/streaming_pb.js";

export {
  type InputMetadata,
  type VideoStreamInfo,
  type AudioStreamInfo,
  type SubtitleStreamInfo,
} from "./gen/transcodely/v1/media_pb.js";

// Codec-specific encoder options. Pass these via OutputSpec.video[].h264 / .h265 / .vp9 / .av1.
export { type H264Options } from "./gen/transcodely/v1/codec_h264_pb.js";
export { type H265Options } from "./gen/transcodely/v1/codec_h265_pb.js";
export { type VP9Options } from "./gen/transcodely/v1/codec_vp9_pb.js";
export { type AV1Options } from "./gen/transcodely/v1/codec_av1_pb.js";
