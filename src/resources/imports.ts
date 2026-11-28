import type { PartialMessage } from "@bufbuild/protobuf";

import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";
import { ImportService } from "../gen/transcodely/v1/import_connect.js";
import {
  AddImportItemsRequest,
  CancelImportRequest,
  CreateImportRequest,
  GetImportRequest,
  type Import,
  type ImportItem,
  ListImportItemsRequest,
  ListImportsRequest,
  PauseImportRequest,
  ResumeImportRequest,
  StartImportRequest,
  UpdateImportRequest,
} from "../gen/transcodely/v1/import_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

/**
 * Bulk imports — bring a whole video library in with one request.
 *
 * An import is a list of source URLs, each of which becomes a hosted video
 * exactly as `client.videos.createFromUrl` would make it. Create it (status
 * `draft`) with up to 1,000 items and append more with `addItems`, up to
 * 10,000 per import; nothing is fetched or encoded yet, and every call returns
 * the import with its `quote`. `start` it with a spend cap (`maxSpendEur`):
 * items are dispatched in submission order, the import pauses
 * (`pauseReason` `spend_cap_reached`) when the next item would take it over
 * the cap, and raising the cap with `update` resumes it. The
 * `import.completed` webhook fires once when no item is left pending or
 * running; `import.paused` fires each time the dispatcher pauses it.
 *
 * Re-running an import is safe: an item whose `externalId` is already held by
 * a pending, running or succeeded item of the same app is `skipped`.
 */
export class Imports {
  constructor(private readonly transport: Transport) {}

  /**
   * Creates an import in `draft` with its first batch of items (1 to 1,000).
   * Nothing is fetched or encoded until {@link Imports.start}; the returned
   * import carries the quote. A URL that is not http(s), or points at a
   * private or internal address, fails the whole request (`invalid_input_url`,
   * naming the item).
   */
  async create(req: PartialMessage<CreateImportRequest>, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.create,
      new CreateImportRequest(req),
      opts,
    );
    return res.import!;
  }

  /**
   * Appends items (1 to 1,000 per call) to a `draft` import, up to 10,000 per
   * import, and returns it with its recomputed quote. Refused with
   * `import_invalid_state` once the import has been started or canceled.
   */
  async addItems(req: PartialMessage<AddImportItemsRequest>, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.addItems,
      new AddImportItemsRequest(req),
      opts,
    );
    return res.import!;
  }

  /** Fetches an import by ID (`imp_*`), with its quote, spend and item counts. */
  async get(id: string, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.get,
      new GetImportRequest({ id }),
      opts,
    );
    return res.import!;
  }

  /** Imports in scope, newest first. Narrow with `status`. */
  list(req: PartialMessage<ListImportsRequest> = {}, opts?: CallOptions): Page<Import> {
    return new Page<Import>(async (cursor) => {
      const proto = new ListImportsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        ImportService,
        ImportService.methods.list,
        proto,
        opts,
      );
      return { items: res.imports, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  /**
   * Starts a `draft` import. A spend cap is required: pass `maxSpendEur` here,
   * or set it at create or with {@link Imports.update}. Enables managed hosting
   * on the app if it is not on yet, as `videos.createFromUrl` does. Refused
   * with `invalid_argument` when the import has no pending items.
   */
  async start(req: PartialMessage<StartImportRequest>, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.start,
      new StartImportRequest(req),
      opts,
    );
    return res.import!;
  }

  /**
   * Changes an import's spend cap (`maxSpendEur`) while it is `draft`,
   * `running` or `paused`. An import paused with `spend_cap_reached` resumes;
   * it pauses again if the new cap still leaves no room for the next item.
   */
  async update(req: PartialMessage<UpdateImportRequest>, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.update,
      new UpdateImportRequest(req),
      opts,
    );
    return res.import!;
  }

  /**
   * Pauses a `running` import (`pauseReason` `manual`). Items already
   * dispatched keep encoding; no new ones are dispatched.
   */
  async pause(id: string, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.pause,
      new PauseImportRequest({ id }),
      opts,
    );
    return res.import!;
  }

  /**
   * Resumes a `paused` import, whatever paused it. If the cause is still there
   * the import pauses again, with the same reason, on the next dispatch.
   */
  async resume(id: string, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.resume,
      new ResumeImportRequest({ id }),
      opts,
    );
    return res.import!;
  }

  /**
   * Cancels a `draft`, `running` or `paused` import. Items not yet dispatched
   * become `canceled`; videos already encoding finish, and their cost still
   * counts toward `spentEur`. Refused with `import_invalid_state` for a
   * completed or already canceled import.
   */
  async cancel(id: string, opts?: CallOptions): Promise<Import> {
    const res = await this.transport.unary(
      ImportService,
      ImportService.methods.cancel,
      new CancelImportRequest({ id }),
      opts,
    );
    return res.import!;
  }

  /**
   * An import's items (`id` is the import), in submission order. Narrow with
   * `status`. Each item names the video it created (`videoId`); a failed item
   * carries the standard error code and message.
   */
  listItems(req: PartialMessage<ListImportItemsRequest>, opts?: CallOptions): Page<ImportItem> {
    return new Page<ImportItem>(async (cursor) => {
      const proto = new ListImportItemsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        ImportService,
        ImportService.methods.listItems,
        proto,
        opts,
      );
      return { items: res.items, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }
}
