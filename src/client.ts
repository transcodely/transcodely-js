/**
 * Transcodely root client. Resource namespaces (`client.jobs`, `client.videos`,
 * etc.) are lazily instantiated on first access so unused namespaces don't
 * pull in their generated message classes.
 */

import { ApiKeys } from "./resources/api-keys.js";
import { Apps } from "./resources/apps.js";
import { Events } from "./resources/events.js";
import { Health } from "./resources/health.js";
import { Jobs } from "./resources/jobs.js";
import { Memberships } from "./resources/memberships.js";
import { Organizations } from "./resources/organizations.js";
import { Origins } from "./resources/origins.js";
import { Presets } from "./resources/presets.js";
import { Users } from "./resources/users.js";
import { Videos } from "./resources/videos.js";
import { WebhookEndpoints } from "./resources/webhook-endpoints.js";
import { Transport, type TransportConfig } from "./transport/transport.js";
import { Webhooks } from "./webhooks/index.js";

export interface TranscodelyConfig extends TransportConfig {}

export class Transcodely {
  static readonly API_VERSION: string;
  static readonly SDK_VERSION: string;

  private readonly transport: Transport;
  private _jobs: Jobs | undefined;
  private _videos: Videos | undefined;
  private _presets: Presets | undefined;
  private _origins: Origins | undefined;
  private _apps: Apps | undefined;
  private _apiKeys: ApiKeys | undefined;
  private _organizations: Organizations | undefined;
  private _memberships: Memberships | undefined;
  private _users: Users | undefined;
  private _health: Health | undefined;
  private _webhookEndpoints: WebhookEndpoints | undefined;
  private _events: Events | undefined;

  constructor(config: TranscodelyConfig) {
    this.transport = new Transport(config);
  }

  /** ID of the most recent successful or failed request, Stripe-style. */
  get lastRequestId(): string | undefined {
    return this.transport.lastRequestId;
  }

  get jobs(): Jobs {
    return (this._jobs ??= new Jobs(this.transport));
  }
  get videos(): Videos {
    return (this._videos ??= new Videos(this.transport));
  }
  get presets(): Presets {
    return (this._presets ??= new Presets(this.transport));
  }
  get origins(): Origins {
    return (this._origins ??= new Origins(this.transport));
  }
  get apps(): Apps {
    return (this._apps ??= new Apps(this.transport));
  }
  get apiKeys(): ApiKeys {
    return (this._apiKeys ??= new ApiKeys(this.transport));
  }
  get organizations(): Organizations {
    return (this._organizations ??= new Organizations(this.transport));
  }
  get memberships(): Memberships {
    return (this._memberships ??= new Memberships(this.transport));
  }
  get users(): Users {
    return (this._users ??= new Users(this.transport));
  }
  get health(): Health {
    return (this._health ??= new Health(this.transport));
  }
  get webhookEndpoints(): WebhookEndpoints {
    return (this._webhookEndpoints ??= new WebhookEndpoints(this.transport));
  }
  get events(): Events {
    return (this._events ??= new Events(this.transport));
  }
  /**
   * Stateless verify-and-decode helper. `client.webhooks.constructEvent(...)`
   * mirrors the Stripe SDK convention. The namespace is also exported at the
   * package root as {@link Webhooks} for consumers who don't instantiate
   * the full client.
   */
  get webhooks(): typeof Webhooks {
    return Webhooks;
  }
}

import { API_VERSION, SDK_VERSION } from "./version.js";
// Static fields can't reference module values inline above without TS5+ static
// initializer block — define them here for broader compat.
(Transcodely as { API_VERSION: string }).API_VERSION = API_VERSION;
(Transcodely as { SDK_VERSION: string }).SDK_VERSION = SDK_VERSION;
