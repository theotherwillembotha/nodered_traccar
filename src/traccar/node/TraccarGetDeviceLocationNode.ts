
import { Node } from "node-red";
import { BaseNode, BaseNodeConfig, JsonUtil, MetricsTemplateConfig, NodeDescription, NodeManager, onInput, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { NodeMessageInFlow } from "node-red";

import { Metrics, MetricsTemplate, MetricType, CounterMetric } from "@theotherwillembotha/node-red-plugincore";
import { Log, Logger, LoggerTemplateConfig, LoggerTemplate } from "@theotherwillembotha/node-red-plugincore";
import { TraccarServerConfigNode } from "./TraccarServerConfigNode";
import { TraccarClient } from "../service/TraccarService";

export interface TraccarGetDeviceLocationNodeConfig extends BaseNodeConfig, MetricsTemplateConfig, LoggerTemplateConfig {
    serverconfig: string;
    device: string;
    device_type: string;
    outputpath: string;
}

@NodeDescription({
    id:"TraccarGetDeviceLocationNode",
    name:"Traccar Get Device Location Node",
    group:"traccar",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "TraccarGetDeviceLocationNode.html",
    package: "@theotherwillembotha/nodered_plugintraccar",
    templates: [
        { template: LoggerTemplate, config: {}},
        { template: MetricsTemplate, config: {}}
    ],
    dependencies: [ TraccarServerConfigNode ],
    tags: [ "Traccar" ]
})
export class TraccarGetDeviceLocationNode extends BaseNode<TraccarGetDeviceLocationNodeConfig> {

    @Logger("TraccarGetDeviceLocationNode")
    private log!:Log;

    @Metrics({name:"received", description:"Number of received events", type:MetricType.Counter })
    private counter!:CounterMetric;

    private _client: TraccarClient;

    constructor(node: Node, config: TraccarGetDeviceLocationNodeConfig){
        super(node, config);

        this._client = (NodeManager.RED.nodes.getNode(config.serverconfig) as any).node().client();

        let clientStatusHandler = {
            connected:()=>{
                this.node().status({fill:"green",shape:"dot",text:"connected"});
            },
            disconnected:()=>{
                this.node().status({fill:"red",shape:"dot",text:"disconnected"});
            }
        };
        
        this._client.subscribeStatusChange(clientStatusHandler)

        // the webserver has been initalized.
        this.node().on("close", () => {
            this._client.unsubscribeStatusChange(clientStatusHandler);
        });
    }

    @onInput()
    protected onInput(message: any, errorHandler: Function) {
        NodeManager.RED.util.evaluateNodeProperty(
            this.config().device,
            this.config().device_type || "str",
            this.node() as any,
            message as NodeMessageInFlow,
            async (err: any, filter: any) => {
                if (err || filter === undefined) {
                    errorHandler(new Error("Could not resolve device filter"));
                    return;
                }
                try {
                    const locations = await this._client.fetchPositions(String(filter));
                    const outputpath = this.config().outputpath || "payload";
                    const data = JsonUtil.jsonUpdate(message, outputpath, locations);
                    this.node().send([data]);
                    this.log.log(message);
                    this.counter.inc();
                } catch (e: any) {
                    errorHandler(e);
                }
            }
        );
    }
}