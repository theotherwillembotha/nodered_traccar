
import { Node } from "node-red";
import { BaseNode, BaseNodeConfig, MetricsTemplateConfig, NodeDescription, NodeManager, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { TraccarClient, TraccarEventSubscription } from "../service/TraccarService";
import { TraccarServerConfigNode } from "./TraccarServerConfigNode";
import { Metrics, MetricsTemplate, MetricType, CounterMetric } from "@theotherwillembotha/node-red-plugincore";
import { Log, Logger, LoggerTemplateConfig, LoggerTemplate } from "@theotherwillembotha/node-red-plugincore";

interface TraccarEventNodeConfig extends BaseNodeConfig, MetricsTemplateConfig, LoggerTemplateConfig {
    traccar_serverconfig: string;
    traccar_subscriptionfilter?: string;
    traccar_getpositionsonconnect:boolean;
}

@NodeDescription({
    id:"TraccarEventNode",
    name:"Traccar Event Node",
    group:"traccar",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "TraccarEventNode.html",
    package: "@theotherwillembotha/node-red-traccar",
    templates: [
        { template: LoggerTemplate, config: {}},
        { template: MetricsTemplate, config: {}}
    ],
    dependencies: [ TraccarServerConfigNode ],
    tags: [ "Traccar" ]
})
export class TraccarEventNode extends BaseNode<TraccarEventNodeConfig> {

    @Logger("TraccarEventNode")
    private log!:Log;

    @Metrics({name:"received", description:"Number of received events", type:MetricType.Counter })
    private counter!:CounterMetric;

    private _client: TraccarClient;
    private subscription: TraccarEventSubscription;

    constructor(node: Node, config: TraccarEventNodeConfig){
        super(node, config);
        let _this = this;

        // get a referecne to the traccar client.
        this._client = (NodeManager.RED.nodes.getNode(config.traccar_serverconfig) as any).node().client();

        this.subscription = this._client.subscribe((config.traccar_subscriptionfilter) ? config.traccar_subscriptionfilter : "" , event => {
            //console.log("event", event);
            this.log.log(event);
            this.counter.inc();
            this.node().send({payload:event});
        });

        let clientStatusHandler = {
            connected:()=>{
                this.node().status({fill:"green",shape:"dot",text:"connected"});

                if(config.traccar_getpositionsonconnect){
                    this._client
                        .fetchPositions((config.traccar_subscriptionfilter) ? config.traccar_subscriptionfilter : "")
                        .then(positions => positions.forEach(position => this.node().send({payload:{position:position}})));
                }

            },
            disconnected:()=>{
                this.node().status({fill:"red",shape:"dot",text:"disconnected"});
            }
        };
        
        this._client.subscribeStatusChange(clientStatusHandler)

        // the webserver has been initalized.
        this.node().on("close", () => {
            console.log("TRACCAR CLOSING");
            this._client.unsubscribeStatusChange(clientStatusHandler);
            this._client.unsubscribe(this.subscription);
        });
    }
}