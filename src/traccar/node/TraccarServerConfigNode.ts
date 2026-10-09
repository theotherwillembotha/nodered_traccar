
import { Node } from "node-red";
import { ConfigNode, ConfigNodeConfig, NodeDescription, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { TraccarClient, TraccarService } from "../service/TraccarService";

interface TraccarServerConfigNodeConfig extends ConfigNodeConfig {
    url: string;
    username: string;
    password: string;
    cacheTimeout: number;
}

@NodeDescription({
    id:"TraccarServerConfigNode",
    name:"Traccar Server Config Node",
    group:"config",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "TraccarServerConfigNode.html",
    package: "@theotherwillembotha/node-red-traccar",
    dependencies: [ TraccarService ],
    tags: [ "Traccar" ]
})
export class TraccarServerConfigNode extends ConfigNode<TraccarServerConfigNodeConfig> {

    private _client:TraccarClient;

    constructor(node: Node, config: TraccarServerConfigNodeConfig){
        super(node, config);
        this._client = new TraccarClient(config.url, config.username, config.password, config.cacheTimeout * 60000);
        TraccarClient.register(node.id, this._client);

        node.on("close", () => {
            TraccarClient.unregister(node.id);
        });
    }

    public client():TraccarClient {
        return this._client;
    }
}
