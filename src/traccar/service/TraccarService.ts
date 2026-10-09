import { NodeAPI, NodeAPISettingsWithData } from "node-red";
import { BaseService, ServiceDescriptor } from "@theotherwillembotha/node-red-plugincore";
import { Cookie } from 'tough-cookie'
import WebSocket from 'ws';
import axios from 'axios';
import qs from 'qs';


type GetDevicesRequest = {
    connection:{
        url:string,
        username:string,
        password:string
    }
}

export class TraccarService extends BaseService {

    private red!: NodeAPI<NodeAPISettingsWithData>;

    constructor(){
        super("TraccarService");
    }

    init(red: NodeAPI<NodeAPISettingsWithData>): void {
        this.red = red;

        this.red.httpAdmin.post("/traccarservice/testconnection", this.red.auth.needsPermission("inject.write"), async (req, res) => {
            const { url, username, password } = req.body as { url: string; username: string; password: string };

            if (!url) {
                res.status(400).send({ error: "url is required" });
                return;
            }

            let sent = false;
            const timeout = setTimeout(() => {
                if (sent) return;
                sent = true;
                res.status(504).send({ error: "Connection timed out" });
            }, 8000);

            try {
                await axios.get(`${url}/api/server`, { timeout: 5000 });

                const devicesResponse = await axios.get(`${url}/api/devices`, {
                    auth: { username: username || "", password: password || "" },
                    timeout: 5000,
                });

                clearTimeout(timeout);
                if (sent) return;
                sent = true;
                res.status(200).send({ message: `Connected successfully - ${devicesResponse.data.length} device(s) visible` });
            } catch (err: any) {
                clearTimeout(timeout);
                if (sent) return;
                sent = true;
                const status = err.response?.status;
                const msg = status === 401 ? "Authentication failed - check username and password"
                          : status === 404 ? "Traccar API not found - check the URL"
                          : err.message || "Connection failed";
                res.status(400).send({ error: msg });
            }
        });

        this.red.httpAdmin.post("/traccarservice/reloadcache", this.red.auth.needsPermission("inject.write"), (req, res) => {
            const { nodeId } = req.body as { nodeId: string };
            const client = TraccarClient.getClient(nodeId);
            if (!client) {
                res.status(404).send({ error: "Client not found - deploy the flow first" });
                return;
            }
            client.invalidateCache();
            res.status(200).send({ message: "Cache invalidated - data will be refreshed on the next event" });
        });

        this.red.httpAdmin.post("/traccarservice/filtersuggestions", this.red.auth.needsPermission("inject.write"), async (req, res) => {
            const { url, username, password } = (req.body as any).connection || {};

            if (!url) {
                res.status(400).send({ error: "url is required" });
                return;
            }

            const auth = { username: username || "", password: password || "" };

            try {
                const [devicesRes, groupsRes] = await Promise.all([
                    axios.get(`${url}/api/devices`, { auth, timeout: 5000 }),
                    axios.get(`${url}/api/groups`,  { auth, timeout: 5000 }),
                ]);

                res.status(200).send({
                    device: (devicesRes.data as any[]).map((d: any) => d.name),
                    group:  (groupsRes.data as any[]).map((g: any) => g.name),
                });
            } catch (err: any) {
                res.status(500).send({ error: err.message || "Failed to fetch suggestions" });
            }
        });

        this.red.httpAdmin.post("/traccarservice/devices", this.red.auth.needsPermission("inject.write"), (req,response) => {
            // first thigns first... we need to get the login details for the connection.
            try{
                let request:GetDevicesRequest = req.body;
                let client = new TraccarClient(request.connection.url, request.connection.username, request.connection.password);
                client.getDevices()
                    .then(devices => {
                        response.send(devices);
                    })
                    .catch(error => {
                        console.log(error);
                        response.status(500).send({error:"Failed retrieving devices"})
                    })
            }
            catch(error){
                response.status(500).send({error:error})
            }
        });
    }

    deinit(red: NodeAPI<NodeAPISettingsWithData>): void {
        console.log("STOPPING SERVICE: " + this.name());
    }

    static override getServiceDescriptor():ServiceDescriptor {
        return new ServiceDescriptor(
            "@theotherwillembotha/node-red-traccar",
            "TraccarService",
            "integration-plugin",
            "./traccar/service/TraccarService",
            TraccarService);
    }
}

export interface TraccarEvent {
    position:Position
}

class Filters{

    private constructor(){};

    public static positionFilter(filter:string):(position:Position)=>boolean{
        // if the filter is empty, then let through everything.
        if(!filter?.trim()){
            return (position:Position) => true;
        }

        // split the subscribeTo into parts with "commas". If a part does not contain a ":", ignore it.
        let parts:((position:Position)=>boolean)[] = filter.split(",")
        .map(s => s.trim())
        .filter(s => s.indexOf(":") > -1)
        .map(s => {
            let [type, query] = s.split(":")
            let selector = type.toLowerCase();
            let expression = new RegExp("^" + query.replaceAll("*", "(.)*") + "$", "g");

            if(selector === "device"){
                return (position:Position) => {
                    let deviceName = position.device?.name;
                    let matches = (deviceName) ? deviceName.match(expression) : [];
                    return matches ? matches.length > 0 : false;
                }
            }

            if(selector === "group"){
                return (position:Position) => {
                    let groups = position.device?.groups;
                    if(groups){
                        for(let group of groups){
                            let matches = group.name.match(expression);
                            if(matches && matches.length > 0){
                                return true;
                            }
                        }
                    }
                    return false;
                }
            }

            console.log(`Unknown selector ${selector}`)
            return (position:Position) => false;
        });
        return (position:Position) => {
            for(let part of parts){
                if(part(position)){
                    return true;
                }
            }
            return false;
        };
    }
}

export class TraccarEventSubscription {
    private filter: (position: Position) => boolean;
    private callback: TraccarEventCallback;
    
    constructor(filterString:string, callback:TraccarEventCallback){
        this.filter = Filters.positionFilter(filterString);
        this.callback = callback;
    }

    public offer(position: Position) {
        if(this.filter(position)){
            this.callback({position:position});
        }
    }
}

export type TraccarEventCallback = (event: TraccarEvent) => void

export class TraccarClient{
    private static _registry: Map<string, TraccarClient> = new Map();

    public static register(nodeId: string, client: TraccarClient): void {
        TraccarClient._registry.set(nodeId, client);
    }

    public static unregister(nodeId: string): void {
        TraccarClient._registry.delete(nodeId);
    }

    public static getClient(nodeId: string): TraccarClient | undefined {
        return TraccarClient._registry.get(nodeId);
    }

    private _url: string;
    private _userName: string;
    private _password: string;
    private _sessionCookie:Cookie[] = [];
    private _users: Cache<{[key:number]:User}>;
    private _groups: Cache<{[key:number]:{group:Group, members:Group[]}}>;
    private _devices: Cache<{[key:number]:Device}>;
    private _subscriptions: TraccarEventSubscription[] = [];
    private _statusChangeListeners: StatusChangeListener[] = [];

    private _cacheTimeout:number = 300000;
    private that = this;

    // @ts-ignore
    private _socket: WebSocket;
    private _connected: boolean = false;

    public constructor(url:string, userName:string, password:string, cacheTimeout?:number){
        this._url = url;
        this._userName = userName;
        this._password = password;
        this._cacheTimeout = cacheTimeout ?? 300000;

        this._users = new Cache(this._cacheTimeout, () => this.fetchUsers());
        this._groups = new Cache(this._cacheTimeout, () => this.fetchGroups());
        this._devices = new Cache(this._cacheTimeout, () => this.fetchDevices());

        let authQuery = qs.stringify({email:this._userName, password:this._password});
        let _this = this;

        try{
            Promise.resolve()
            //get server info.
            .then(async () => {
                return axios.get(`${this._url}/api/server`, {})
                .then(response => {
                    //console.log(response.data);
                })
            })
            // pull some parts.
            .then(async () => {
                return Promise.resolve()
                .then(() => this.getGroups().then(groups => console.log(groups.length + " groups loaded")))
                .then(() => this.getDevices().then(devices => console.log(devices.length + " devices loaded")))
                .then(() => this.getUsers().then(users => console.log(users.length + " users loaded")))
            })
            // Get the session token / cookie
            .then(async () => {
                return axios.post(`${this._url}/api/session`, authQuery, {headers: { 'content-type': 'application/x-www-form-urlencoded' }})
                .then(response => {
                    let cookie = response.headers["set-cookie"];
                    if(cookie){
                        this._sessionCookie = cookie.map(t => Cookie.parse(t)).filter(t => !!(t)) as Cookie[]
                    }
                })
            })
            // Subscribe to the Websocket endpoint.
            .then(async () => {
                let cookieHeader = this._sessionCookie.map(t => t?.cookieString()).join(";");
                this._socket = new WebSocket(`${this._url.replace(/^http/, "ws")}/api/socket`, { headers:{cookie:cookieHeader}});
                this._socket.addEventListener('open', event => {
                    console.log('WebSocket connection established!');
                    // notify the status listeners.
                    this._connected = true;
                    this._statusChangeListeners.forEach(listener => {
                        try{ if(listener.connected) listener.connected(); }
                        catch(err){}
                    })
                });
                this._socket.addEventListener('message', event => {
                    let payload:Payload = JSON.parse(event.data.toString());
                    ((payload.devices) ? payload.devices : []).forEach(device => _this.handleDevice(device));
                    ((payload.events) ? payload.events : []).forEach(event => _this.handleEvent(event));
                    ((payload.positions) ? payload.positions : []).forEach(position => _this.handlePosition(position));
                })                  
                // Executes when the connection is closed, providing the close code and reason.
                this._socket.addEventListener('close', event => {
                    console.log('WebSocket connection closed:', event.code, event.reason);
                    this._connected = false;
                    this._statusChangeListeners.forEach(listener => {
                        try{ if(listener.disconnected) listener.disconnected(); }
                        catch(err){}
                    })
                });
                // Executes if an error occurs during the WebSocket communication.
                this._socket.addEventListener('error', error => {
                    console.error('WebSocket error:');
                });
                return Promise.resolve()
            })
            .catch((error:Error) => {
                console.log("ERRORNAME", error.name);
                console.log("ERRORMESSAGE", error.message);
            })
        }
        catch(e){
            console.log("ERROR", e);
        }
    }

    public subscribeStatusChange(callback: StatusChangeListener){
        this._statusChangeListeners.push(callback);
        
        // after subscribing, update the current status.
        if(this.isConnected()){
            if(callback.connected){
                callback.connected();
            }  
        }
        else{
            if(callback.disconnected){
                callback.disconnected();
            }
        }
    }

    public isConnected():boolean{
        return this._connected;
    }

    public invalidateCache(): void {
        this._users.invalidate();
        this._groups.invalidate();
        this._devices.invalidate();
    }
    
    public unsubscribeStatusChange(callback: StatusChangeListener){
        this._statusChangeListeners.splice(this._statusChangeListeners.indexOf(callback), 1);
    }

    public subscribe(subscribeTo: string, callback: TraccarEventCallback):TraccarEventSubscription {
        let subscription = new TraccarEventSubscription(subscribeTo, callback);
        this._subscriptions.push(subscription);
        console.log(`subscribed. total number of subscriptions: ${this._subscriptions.length}`);
        return subscription;
    }

    public unsubscribe(subscription: TraccarEventSubscription) {
        this._subscriptions.splice(this._subscriptions.indexOf(subscription), 1);
        console.log(`unsubscribed. total number of subscriptions: ${this._subscriptions.length}`);
    }

    private async fetchUsers():Promise<{[key:number]:User}>{
        return axios.get<User[]>(
            `${this._url}/api/users`, {
            auth: { username: this._userName, password: this._password }
        })
        .then(response => {
            let users:{[key:number]:User} = {};
            response.data.forEach(user => users[user.id] = user);
            return users;
        })
        .catch(error => {
            return {};
        })
    }

    private async fetchGroups():Promise<{[key:number]:{group:Group, members:Group[]}}>{
        return axios.get<Group[]>(
            `${this._url}/api/groups`, {
            auth: { username: this._userName, password: this._password }
        })
        .then(result => {
            let groups = result.data;

            // add the groups to the list of groups.
            let tmpGroups:{[key:number]:{group:Group, members:Group[]}} = {};

            groups.forEach(group => {
                tmpGroups[group.id] = {group: group, members: [] };
            });

            let findParentGroup = (group:Group):Group[] => {
                let parent = groups.find(g => g.id == group.groupId);
                if(!parent){
                    return [group];
                }
                else{
                    let parentGroups = findParentGroup(parent);
                    parentGroups.push(group);
                    return parentGroups;
                }
            }

            // add the members to each group.
            groups.forEach(group => {
                // for this group, find the groups that reference it.
                tmpGroups[group.id].members = findParentGroup(group);
            });

            return tmpGroups;
        })
        .catch(error => {
            console.log(error);
            return {};
        })
    }

    private async fetchDevices():Promise<{[key:number]:Device}>{
        return axios.get<Device[]>(
            `${this._url}/api/devices`, {
            auth: { username: this._userName, password: this._password }
        })
        .then(async result => {
            // get the groups.
            let groups = await this._groups.get();

            // enrich the device.
            let tmpDevices:{[key:number]: Device} =  {};
            result.data.forEach(device => { tmpDevices[device.id] = device })
            Object.values(tmpDevices).forEach(device => device.groups = groups[device.groupId]?.members ?? []);
            return tmpDevices;
        })
        .catch(error => {
            //console.log(error);
            return {};
        })
    }

    public fetchPositions(filterString: string):Promise<{}[]> {
        return axios.get<Position[]>(
            `${this._url}/api/positions`, {
            auth: { username: this._userName, password: this._password }
        })
        .then(async response => {
            let filter = Filters.positionFilter(filterString);

            // enrich the data...
            let positions = response.data;
            for(let position of positions){
                position.device = (await this._devices.get())[position.deviceId];
            }

            return positions.filter(position => filter(position));
        })
    }

    public async getUsers(): Promise<User[]> {
        return Object.values(await this._users.get());
    }

    public async getGroups():Promise<Group[]> {
        return Object.values(await this._groups.get()).map(g => g.group);
    }

    public async getDevices():Promise<Device[]> {
        return Object.values(await this._devices.get());
    }

    private async handleDevice(device: Device): Promise<void> {
        // enrich the device: GROUPS
        device.groups = (await this._groups.get())[device.groupId]?.members;
    }

    private async handleEvent(event: Event): Promise<void> {
        console.log("HANDLE EVENT: ", JSON.stringify(event, null, 2));
    }

    private async  handlePosition(position: Position, notifySubscribers:boolean = true): Promise<void> {
        // enrich the position: DEVICES.
        position.device = (await this._devices.get())[position.deviceId];

        if(notifySubscribers){
            for(let subscription of this._subscriptions){
                try{
                    subscription.offer(position);
                }
                catch(e){
                    console.log(e);
                }
            }
        }
    }
}

class Cache<Type>{

    private fetchFunction: () => Type | Promise<Type>;
    private cacheTimeout: number;
    private timedOut:boolean = true;
    //@ts-ignore
    private data: Type;

    constructor(cacheTimeout:number, fetchFunction:()=>Type|Promise<Type>){
        this.cacheTimeout = cacheTimeout;
        this.fetchFunction = fetchFunction;
    }

    public invalidate(): void {
        this.timedOut = true;
    }

    public get():Promise<Type>{
        if(this.cacheTimeout === 0){
            return Promise.resolve().then(() => this.fetchFunction());
        }
        if(this.timedOut){
            return Promise.resolve()
                .then(() => this.fetchFunction())
                .then(result => this.data = result)
                .then(() => {
                    this.timedOut = false;
                    setTimeout(() => {
                        this.timedOut = true;
                    }, this.cacheTimeout);
                })
                .then(() => this.data);
        }
        else{
            return Promise.resolve().then(() => this.data);
        }
    }
}

export type StatusChangeListener = {
    connected?:()=>void
    disconnected?:()=>void
}

interface Payload {
    devices?: Device[],
    positions?: Position[],
    events?: Event[]
}

interface Group {
    id:number,
    attributes:{},
    groupId:number;
    name:string
}

interface Device {
    id: number,
    attributes:{},
    groupId: number,
    groups?:Group[],
    calendarId: number,
    name: string,
    uniqueId: string,
    status: string,
    lastUpdate: string,
    positionId: number,
    phone: string,
    model: string,
    contact: any,
    category: string,
    disabled: boolean,
    expirationTime: any,
}

interface User{
    id:number,
    attributes:{},
    name: string,
    login: any,
    email: string,
    phone: any,
    readonly: boolean,
    administrator: boolean,
    map: any,
    latitude: number,
    longitude: number,
    zoom: number,
    
    /*
    coordinateFormat: null,
    disabled: false,
    expirationTime: null,
    deviceLimit: -1,
    userLimit: 0,
    deviceReadonly: false,
    limitCommands: false,
    disableReports: false,
    fixedEmail: false,
    poiLayer: null,
    totpKey: null,
    temporary: false,
    password: null
    */
}

interface Event{

}


interface Position{
    id:number,
    attributes:{},
    deviceId:number,
    device?: Device;
    protocol:string,
    serverTime:string,
    deviceTime:string,
    fixTime:string,
    outdated:boolean,
    valid:boolean,
    latitude:number,
    longitude:number,
    altetude:number,
    speed:number,
    course:number,
    address:any,
    accuracy:number,
    geofenceIds?:number[],
    network?: {
        radioType: string,  // known values: gsm
        considerIp: boolean,   
        cellTowers?:any []
    },

    /*
    attributes: {
        batteryLevel: 100,
        ignition: false,
        status: 4294966271,
        distance: 0,
        totalDistance: 20440807.250040814,
        motion: false
    }
    */
}

interface ServerInfo {
    id:number,
    attributes: {},
    registration:boolean,
    readonly: boolean,
    version: string,
    /*
    deviceReadonly: false,
    map: null,
    bingKey: null,
    mapUrl: null,
    overlayUrl: null,
    latitude: 0,
    longitude: 0,
    zoom: 0,
    forceSettings: false,
    coordinateFormat: null,
    limitCommands: false,
    disableReports: false,
    fixedEmail: false,
    poiLayer: null,
    announcement: null,
    emailEnabled: false,
    geocoderEnabled: true,
    textEnabled: false,
    storageSpace: null,
    newServer: false,
    openIdEnabled: false,
    openIdForce: false,
    */
}

interface SessionInfo {
    id:number,
    attributes:{
        timezone:string,
        notificationTokens:string,
    }
    /*
    id: 1,
    attributes: {
      timezone: 'Africa/Johannesburg',
      notificationTokens: 'ccvfEcXFQS-8KyikU5ATpq:APA91bG-hSQUjP5M33NqT5tnbsW4aBM3gLxUkRaeRddjzUJkwEf52uNj_Fkw1ZAUZqL96Ag4ufOXL4n4r5GIpgDs2akqc95TvuG2kdaaKYsO0EUSLgBkV_dyqpToCfVMp6OiaZHeW_p9'
    },
    name: 'admin',
    login: null,
    email: 'admin',
    phone: null,
    readonly: false,
    administrator: true,
    map: null,
    latitude: -25.770978,
    longitude: 28.297764,
    zoom: 13,
    coordinateFormat: null,
    disabled: false,
    expirationTime: null,
    deviceLimit: -1,
    userLimit: 0,
    deviceReadonly: false,
    limitCommands: false,
    disableReports: false,
    fixedEmail: false,
    poiLayer: null,
    totpKey: null,
    temporary: false,
    password: null
    */
}
