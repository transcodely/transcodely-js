import { HealthService } from "../gen/transcodely/v1/health_connect.js";
import { HealthCheckRequest } from "../gen/transcodely/v1/health_pb.js";

import type { CallOptions, Transport } from "../transport/transport.js";

export class Health {
  constructor(private readonly transport: Transport) {}

  check(opts?: CallOptions) {
    return this.transport.unary(
      HealthService,
      HealthService.methods.check,
      new HealthCheckRequest(),
      opts,
    );
  }
}
