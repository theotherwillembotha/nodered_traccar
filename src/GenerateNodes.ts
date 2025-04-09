import { NodeGenerator } from "@theotherwillembotha/node-red-plugincore";

// nodes.
import { TraccarService } from "./traccar/service/TraccarService";
import { TraccarServerConfigNode } from "./traccar/node/TraccarServerConfigNode";
import { TraccarEventNode } from "./traccar/node/TraccarEventNode";
import { TraccarGetDeviceLocationNode } from "./traccar/node/TraccarGetDeviceLocationNode";

new NodeGenerator("./src/")
    // services.
    .registerService(TraccarService)

    // nodes
    .registerNode(TraccarServerConfigNode)
    .registerNode(TraccarGetDeviceLocationNode)
    .registerNode(TraccarEventNode)

    // done.
    .generate("./build/Nodes", "./build/Plugins");

process.exit(0);