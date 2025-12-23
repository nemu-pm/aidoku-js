import { buildApplication, buildRouteMap } from "@stricli/core";
import { list } from "./commands/list";
import { info } from "./commands/info";
import { testRoutes } from "./commands/test";
import { explore } from "./commands/explore";
import { registry } from "./commands/registry";

const routes = buildRouteMap({
  routes: {
    list,
    info,
    test: testRoutes,
    explore,
    registry,
  },
  docs: {
    brief: "Aidoku source development CLI",
  },
});

export const app = buildApplication(routes, {
  name: "aidoku",
  versionInfo: {
    currentVersion: "0.1.0",
  },
});

