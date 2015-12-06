"use strict";

import request from "superagent";
import WebSocket from "ws";
import ConnectionState from "./ConnectionState";
import qs from "querystring";

import {Endpoints, PacketType, Permissions} from "../Constants";

import Cache from "../Util/Cache";
import Resolver from "./Resolver/Resolver";

import User from "../Structures/User";
import Channel from "../Structures/Channel";
import TextChannel from "../Structures/TextChannel";
import VoiceChannel from "../Structures/VoiceChannel";
import PMChannel from "../Structures/PMChannel";
import Server from "../Structures/Server";
import Message from "../Structures/Message";
import Role from "../Structures/Role";
import Invite from "../Structures/Invite";
import VoiceConnection from "../Voice/VoiceConnection";

var zlib;

//todo: move this somewhere else
var originalEnd = request.Request.prototype.end;
request.Request.prototype.end = function(callback) {
	return new Promise((resolve, reject) => {
		originalEnd.call(this, (err, response) => {
			if (callback) {
				callback(err, response);
			}

			if (err) {
				return reject(err);
			}
			resolve(response);
		});
	});
};

function waitFor(condition, value = condition, interval = 20) {
	return new Promise(resolve => {
		var int = setInterval(() => {
			var isDone = condition();
			if(isDone) {
				if(condition === value) {
					resolve(isDone);
				} else {
					resolve(value(isDone));
				}
				return clearInterval(int);
			}
		}, interval);
	});
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export default class InternalClient {
	constructor(discordClient) {
		this.setup(discordClient);
	}

	setup(discordClient) {
		discordClient = discordClient || this.client;
		this.client = discordClient;
		this.state = ConnectionState.IDLE;
		this.websocket = null;

		if (this.client.options.compress) {
			zlib = require("zlib");
		}

		// creates 4 caches with discriminators based on ID
		this.users = new Cache();
		this.channels = new Cache();
		this.servers = new Cache();
		this.private_channels = new Cache();

		this.intervals = {
			typing : [],
			kai : null,
			misc : []
		};

		this.voiceConnection = null;
		this.resolver = new Resolver(this);
		this.readyTime = null;
		this.messageAwaits = {};
	}

	cleanIntervals(){
		for(let interval of this.intervals.typing.concat(this.intervals.misc).concat(this.intervals.kai)){
			if(interval){
				clearInterval(interval);
			}
		}
	}

	disconnected(forced = false){

		this.cleanIntervals();

		this.leaveVoiceChannel();

		if(this.client.options.autoRevive && !forced){
			this.setup();
			this.login(this.email, this.password);
		}

		this.client.emit("disconnected");
	}

	get uptime() {
		return (this.readyTime ? Date.now() - this.readyTime : null);
	}

	//def leaveVoiceChannel
	leaveVoiceChannel() {
		if (this.voiceConnection) {
			this.voiceConnection.destroy();
			this.voiceConnection = null;
		}
		return Promise.resolve();
	}

	//def awaitResponse
	awaitResponse(msg){
		return new Promise((resolve, reject) => {

			msg = this.resolver.resolveMessage(msg);

			if(!msg){
				reject(new Error("message undefined"));
				return;
			}

			var awaitID = msg.channel.id + msg.author.id;

			if( !this.messageAwaits[awaitID] ){
				this.messageAwaits[awaitID] = [];
			}

			this.messageAwaits[awaitID].push(resolve);
		});
	}

	//def joinVoiceChannel
	joinVoiceChannel(chann) {
		var channel = this.resolver.resolveVoiceChannel(chann);

		if (!channel) {
			return Promise.reject(new Error("voice channel does not exist"));
		}
		return this.leaveVoiceChannel()
		.then(() => {
			return new Promise((resolve, reject) => {
				var session, token, server = channel.server, endpoint;

				var check = m => {
					var data = JSON.parse(m);
					if (data.t === "VOICE_STATE_UPDATE") {
						session = data.d.session_id;
					} else if (data.t === "VOICE_SERVER_UPDATE") {
						token = data.d.token;
						endpoint = data.d.endpoint;
						var chan = this.voiceConnection = new VoiceConnection(
							channel, this.client, session, token, server, endpoint
						);

						chan.on("ready", () => resolve(chan));
						chan.on("error", reject);

						this.client.emit("debug", "removed temporary voice websocket listeners");
						this.websocket.removeListener("message", check);

					}
				};

				this.websocket.on("message", check);
				this.sendWS({
					op: 4,
					d: {
						"guild_id": server.id,
						"channel_id": channel.id,
						"self_mute": false,
						"self_deaf": false
					}
				});
			});
		});
	}

	// def createServer
	createServer(name, region = "london") {
		name = this.resolver.resolveString(name);

		return request
		.post(Endpoints.SERVERS)
		.set("authorization", this.token)
		.send({ name, region })
		.end()
		.then(res => {
			// valid server, wait until it is cached
			return waitFor(() => this.servers.get("id", res.body.id));
		});
	}

	//def joinServer
	joinServer(invite) {
		invite = this.resolver.resolveInviteID(invite);
		if(!invite) {
			return Promise.reject(new Error("Not a valid invite"));
		}
		return request
		.post(Endpoints.INVITE(invite))
		.set("authorization", this.token)
		.end()
		.then(res => {
			// valid server, wait until it is received via ws and cached
			return waitFor(() => this.servers.get("id", res.body.guild.id));
		});

	}

	//def leaveServer
	leaveServer(srv) {
		var server = this.resolver.resolveServer(srv);
		if(!server) {
			return Promise.reject(new Error("server did not resolve"));
		}

		return request
		.del(Endpoints.SERVER(server.id))
		.set("authorization", this.token)
		.end()
		.then(() => {
			// remove channels of server then the server
			for (var chan of server.channels) {
				this.channels.remove(chan);
			}
			// remove server
			this.servers.remove(server);
		});
	}

	// def login
	login(email, password) {
		var client = this.client;
		if(this.state !== ConnectionState.DISCONNECTED && this.state !== ConnectionState.IDLE) {
			return Promise.reject(new Error("already logging in/logged in/ready!"));
		}

		this.state = ConnectionState.LOGGING_IN;

		return request
		.post(Endpoints.LOGIN)
		.send({
			email,
			password
		})
		.end()
		.then(res => {
			var token = res.body.token;
			this.state = ConnectionState.LOGGED_IN;
			this.token = token;
			this.email = email;
			this.password = password;

			return this.getGateway()
			.then(url => {
				this.createWS(url);
				return token;
			});
		}, error => {
			this.websocket = null;
			throw error;
		})
		.catch(error => {
			this.state = ConnectionState.DISCONNECTED;
			client.emit("disconnected");
			throw error;
		});
	}

	// def logout
	logout() {
		if (this.state === ConnectionState.DISCONNECTED || this.state === ConnectionState.IDLE) {
			return Promise.reject(new Error("Client is not logged in!"));
		}

		return request
		.post(Endpoints.LOGOUT)
		.set("authorization", this.token)
		.end()
		.then(() => {
			if (this.websocket) {
				this.websocket.close();
				this.websocket = null;
			}
			this.token = null;
			this.email = null;
			this.password = null;
			this.state = ConnectionState.DISCONNECTED;
		});
	}

	// def startPM
	startPM(resUser) {
		var user = this.resolver.resolveUser(resUser);
		if(!user) {
			return Promise.reject(new Error("Unable to resolve resUser to a User"));
		}
				// start the PM
		return request
		.post(`${Endpoints.USER_CHANNELS(user.id) }`)
		.set("authorization", this.token)
		.send({
			recipient_id: user.id
		})
		.end()
		.then(res => {
			return this.private_channels.add(new PMChannel(res.body, this.client));
		});
	}

	// def getGateway
	getGateway() {
		return request
		.get(Endpoints.GATEWAY)
		.set("authorization", this.token)
		.end()
		.then(res => res.body.url);
	}

	// def sendMessage
	sendMessage(where, _content, options = {}) {

		return this.resolver.resolveChannel(where)
		.then(destination => {
			//var destination;
			var content = this.resolver.resolveString(_content);
			var mentions = this.resolver.resolveMentions(content);

			return request
			.post(Endpoints.CHANNEL_MESSAGES(destination.id))
			.set("authorization", this.token)
			.send({
				content: content,
				mentions: mentions,
				tts: options.tts
			})
			.end()
			.then(res =>
				destination.messages.add(new Message(res.body, destination, this.client))
			);
		});

	}
	// def deleteMessage
	deleteMessage(_message, options = {}) {

		var message = this.resolver.resolveMessage(_message);
		if(!message) {
			return Promise.reject(new Error("Supplied message did not resolve to a message!"));
		}

		var chain = options.wait ? delay(options.wait) : Promise.resolve();
		return chain.then(() =>
			request
			.del(Endpoints.CHANNEL_MESSAGE(message.channel.id, message.id))
			.set("authorization", this.token)
			.end()
		)
		.then(() => message.channel.messages.remove(message));
	}

	// def updateMessage
	updateMessage(msg, _content, options = {}) {

		var message = this.resolver.resolveMessage(msg);

		if(!message) {
			return Promise.reject(new Error("Supplied message did not resolve to a message!"));
		}

		var content = this.resolver.resolveString(_content);
		var mentions = this.resolver.resolveMentions(content);

		return request
		.patch(Endpoints.CHANNEL_MESSAGE(message.channel.id, message.id))
		.set("authorization", this.token)
		.send({
			content: content,
			tts: options.tts,
			mentions: mentions
		})
		.end()
		.then(res => message.channel.messages.update(
			message,
			new Message(res.body, message.channel, this.client)
		));
	}

	// def sendFile
	sendFile(where, _file, name = "image.png") {
		return this.resolver.resolveChannel(where)
		.then(channel =>
			request
			.post(Endpoints.CHANNEL_MESSAGES(channel.id))
			.set("authorization", this.token)
			.attach("file", this.resolver.resolveFile(_file), name)
			.end()
			.then(res => channel.messages.add(new Message(res.body, channel, this.client)))
		);
	}

	// def getChannelLogs
	getChannelLogs(_channel, limit = 500, options = {}) {
		return this.resolver.resolveChannel(_channel)
		.then(channel => {
			var qsObject = {limit};
			if (options.before) {
				const res = this.resolver.resolveMessage(options.before);
				if(res) {
					qsObject.before = res;
				}
			}
			if (options.after) {
				const res = this.resolver.resolveMessage(options.after);
				if(res) {
					qsObject.after = res;
				}
			}

			return request
			.get(Endpoints.CHANNEL_MESSAGES(channel.id) + "?" + qs.stringify(qsObject))
			.set("authorization", this.token)
			.end()
			.then(res => res.body.map(
				msg => channel.messages.add(new Message(msg, channel, this.client))
			));
		});
	}

	// def getBans
	getBans(server) {
		server = this.resolver.resolveServer(server);

		return request
		.get(`${Endpoints.SERVER_BANS(server.id) }`)
		.set("authorization", this.token)
		.end()
		.then(res => {
			res.body.map(ban => {
				return this.users.add(new User(ban.user, this.client));
			});
		});
	}

	// def createChannel
	createChannel(server, name, type = "text") {

		server = this.resolver.resolveServer(server);

		return request
		.post(Endpoints.SERVER_CHANNELS(server.id))
		.set("authorization", this.token)
		.send({
			name,
			type
		})
		.end()
		.then(res => {
			var channel;
			if (res.body.type === "text") {
				channel = new TextChannel(res.body, this.client, server);
			}else{
				channel = new VoiceChannel(res.body, this.client, server);
			}
			return server.channels.add(this.channels.add(channel));
		});
	}

	// def deleteChannel
	deleteChannel(_channel) {

		return this.resolver.resolveChannel(_channel)
		.then(channel =>
			request
			.del(Endpoints.CHANNEL(channel.id))
			.set("authorization", this.token)
			.end()
			.then(() => {
				channel.server.channels.remove(channel);
				this.channels.remove(channel);
			}), error => {
			error.message = "Couldn't resolve to channel - " + error.toString();
			throw error;
		});
	}

	// def banMember
	banMember(user, server, length = 1) {
		user = this.resolver.resolveUser(user);
		server = this.resolver.resolveServer(server);

		return request
		.put(`${Endpoints.SERVER_BANS(server.id)}/${user.id}?delete-message-days=${length}`)
		.set("authorization", this.token)
		.end();//will expose api result, probably not bad tho
	}

	// def unbanMember
	unbanMember(user, server) {

		server = this.resolver.resolveServer(server);
		user = this.resolver.resolveUser(user);

		return request
		.del(`${Endpoints.SERVER_BANS(server.id) }/${user.id}`)
		.set("authorization", this.token)
		.end();//will expose api result, probably not bad tho
	}

	// def kickMember
	kickMember(user, server) {
		user = this.resolver.resolveUser(user);
		server = this.resolver.resolveServer(server);

		return request
		.del(`${Endpoints.SERVER_MEMBERS(server.id) }/${user.id}`)
		.set("authorization", this.token)
		.end();
	}

	// def createRole
	createRole(server, data) {
		server = this.resolver.resolveServer(server);

		return request
		.post(Endpoints.SERVER_ROLES(server.id))
		.set("authorization", this.token)
		.end()
		.then(res => {
			var role = server.roles.add(new Role(res.body, server, this.client));

			if (data) {
				return this.updateRole(role, data);
			}
			return role;

		});
	}
	// def updateRole
	updateRole(role, data) {

		var server = this.resolver.resolveServer(role.server);

		var newData = {
			color: data.color || role.color,
			hoist: data.hoist || role.hoist,
			name: data.name || role.name,
			permissions: role.permissions || 0
		};

		if(data.permissions) {
			newData.permissions = 0;
			for (var perm of data.permissions) {
				if (perm instanceof String || typeof perm === "string") {
					newData.permissions |= (Permissions[perm] || 0);
				} else {
					newData.permissions |= perm;
				}
			}
		}

		return request
		.patch(Endpoints.SERVER_ROLES(server.id) + "/" + role.id)
		.set("authorization", this.token)
		.send(newData)
		.end()
		.then(res => {
			return server.roles.update(role, new Role(res.body, server, this.client));
		});
	}

	// def deleteRole
	deleteRole(role) {
		return request
		.del(Endpoints.SERVER_ROLES(role.server.id) + "/" + role.id)
		.set("authorization", this.token)
		.end();
	}

	//def addMemberToRole
	addMemberToRole(member, role) {
		member = this.resolver.resolveUser(member);

		if (!member || !role) {
			return Promise.reject(new Error("member/role not in server"));
		}

		if (!role.server.memberMap[member.id]) {
			return Promise.reject(new Error("member not in server"));
		}

		var roleIDS = role.server.memberMap[member.id].roles.map(r => r.id).concat(role.id);

		return request
		.patch(Endpoints.SERVER_MEMBERS(role.server.id) + "/" + member.id)
		.set("authorization", this.token)
		.send({
			roles: roleIDS
		})
		.end();
	}

	//def addMemberToRole
	addMemberToRoles(member, roles) {
		member = this.resolver.resolveUser(member);

		if (!member) {
			return Promise.reject(new Error("member not in server"));
		}

		if (!Array.isArray(roles) || roles.length === 0) {
			return Promise.reject(new Error("invalid array of roles"));
		}

		var roleIDS = roles[0].server.memberMap[member.id].roles.map(r => r.id);

		for(var role of roles) {
			if (!role.server.memberMap[member.id]) {
				return Promise.reject(new Error("member not in server"));
			}
			roleIDS.concat(role.id);
		}

		return request
		.patch(Endpoints.SERVER_MEMBERS(role.server.id) + "/" + member.id)
		.set("authorization", this.token)
		.send({
			roles: roleIDS
		})
		.end();
	}

	//def removeMemberFromRole
	removeMemberFromRole(member, role) {
		member = this.resolver.resolveUser(member);

		if (!member || !role) {
			return Promise.reject(new Error("member/role not in server"));
		}

		if (!role.server.memberMap[member.id]) {
			return Promise.reject(new Error("member not in server"));
		}

		var roleIDS = role.server.memberMap[member.id].roles.map(r => r.id);

		for (var item in roleIDS) {
			if (roleIDS[item] === role.id) {
				roleIDS.splice(item, 1);
				break;
			}
		}

		return request
		.patch(Endpoints.SERVER_MEMBERS(role.server.id) + "/" + member.id)
		.set("authorization", this.token)
		.send({
			roles: roleIDS
		})
		.end();
	}

	//def removeMemberFromRoles
	removeMemberFromRoles(member, roles) {
		member = this.resolver.resolveUser(member);

		if (!member) {
			return Promise.reject(new Error("member not in server"));
		}

		if (!Array.isArray(roles) || roles.length === 0) {
			return Promise.reject(new Error("invalid array of roles"));
		}

		var roleIDS = roles[0].server.memberMap[member.id].roles.map(r => r.id);

		for(var role of roles) {
			if (!role.server.memberMap[member.id]) {
				return Promise.reject(new Error("member not in server"));
			}
			for (var item in roleIDS) {
				if (roleIDS[item] === role.id) {
					roleIDS.splice(item, 1);
					break;
				}
			}
		}

		return request
		.patch(Endpoints.SERVER_MEMBERS(role.server.id) + "/" + member.id)
		.set("authorization", this.token)
		.send({
			roles: roleIDS
		})
		.end();
	}

	// def createInvite
	createInvite(chanServ, options) {
		if (chanServ instanceof Channel) {
			// do something
		} else if (chanServ instanceof Server) {
			// do something
		} else {
			chanServ = this.resolver.resolveServer(chanServ) || this.resolver.resolveChannel(chanServ);
		}

		if (!chanServ) {
			throw new Error("couldn't resolve where");
		}

		if (!options) {
			options = {
				validate: null
			};
		} else {
			options.max_age = options.maxAge || 0;
			options.max_uses = options.maxUses || 0;
			options.temporary = options.temporary || false;
			options.xkcdpass = options.xkcd || false;
		}

		var epoint;
		if (chanServ instanceof Channel) {
			epoint = Endpoints.CHANNEL_INVITES(chanServ.id);
		} else {
			epoint = Endpoints.SERVER_INVITES(chanServ.id);
		}

		return request
		.post(epoint)
		.set("authorization", this.token)
		.send(options)
		.end()
		.then(res => new Invite(res.body, this.channels.get("id", res.body.channel.id), this.client));
	}

	//def deleteInvite
	deleteInvite(invite) {

		invite = this.resolver.resolveInviteID(invite);
		if(!invite) {
			throw new Error("Not a valid invite");
		}
		return request
		.del(Endpoints.INVITE(invite))
		.set("authorization", this.token)
		.end();
	}

	//def overwritePermissions
	overwritePermissions(channel, role, updated) {
		return this.resolver.resolveChannel(channel)
		.then(channel => {
			var user;
			if (role instanceof User) {
				user = role;
			}

			var data = {};
			data.allow = 0;
			data.deny = 0;

			updated.allow = updated.allow || [];
			updated.deny = updated.deny || [];

			if (role instanceof Role) {
				data.id = role.id;
				data.type = "role";
			} else if (user) {
				data.id = user.id;
				data.type = "member";
			} else {
				throw new Error("role incorrect");
			}

			for (var perm in updated) {
				if (updated[perm]) {
					if (perm instanceof String || typeof perm === "string") {
						data.allow |= (Permissions[perm] || 0);
					} else {
						data.allow |= perm;
					}
				} else {
					if (perm instanceof String || typeof perm === "string") {
						data.deny |= (Permissions[perm] || 0);
					} else {
						data.deny |= perm;
					}
				}
			}

			return request
			.put(Endpoints.CHANNEL_PERMISSIONS(channel.id) + "/" + data.id)
			.set("authorization", this.token)
			.send(data)
			.end();
		});
	}

	//def setStatus
	setStatus(idleStatus, gameID) {

		this.idleStatus = idleStatus || this.idleStatus || null;
		if(idleStatus){
			if(idleStatus === "online" || idleStatus === "here" || idleStatus === "available"){
				this.idleStatus = null;
			}
		}
		this.gameID = this.resolver.resolveGameID(gameID) || this.gameID || null;

		var packet = {
			op: 3,
			d: {
				idle_since: this.idleStatus,
				game_id: this.gameID
			}
		};

		if (this.idleStatus === "idle" || this.idleStatus === "away") {
			packet.d.idle_since = Date.now();
		}

		this.sendWS(packet);

		return Promise.resolve();//why?

	}

	//def sendTyping
	sendTyping(channel) {
		return this.resolver.resolveChannel(channel).then(channel =>
			request
			.post(Endpoints.CHANNEL(channel.id) + "/typing")
			.set("authorization", this.token)
			.end()
		);
	}

	//def startTyping
	startTyping(channel){
		return this.resolver.resolveChannel(channel)
		.then(channel => {

			if(this.intervals.typing[channel.id]){
				// typing interval already exists, leave it alone
				throw new Error("Already typing in that channel");
			}

			this.intervals.typing[channel.id] = setInterval(
				() => this.sendTyping(channel)
				.catch(error => this.emit("error", error)),
				4000
			);

			return this.sendTyping(channel);
		});

	}

	//def stopTyping
	stopTyping(channel){
		return this.resolver.resolveChannel(channel)
		.then(channel => {

			if(!this.intervals.typing[channel.id]){
				// typing interval doesn't exist
				throw new Error("Not typing in that channel");
			}

			clearInterval(this.intervals.typing[channel.id]);
			this.intervals.typing[channel.id] = false;

		});
	}

	//def updateDetails
	updateDetails(data) {
		return request
		.patch(Endpoints.ME)
		.set("authorization", this.token)
		.send({
			avatar: this.resolver.resolveToBase64(data.avatar) || this.user.avatar,
			email : data.email || this.email,
			new_password : data.newPassword || null,
			password : data.password || this.password,
			username : data.username || this.user.username
		})
		.end();
	}

	//def setAvatar
	setAvatar(avatar) {
		return this.updateDetails({avatar});
	}

	//def setUsername
	setUsername(username) {
		return this.updateDetails({username});
	}

	//def setTopic
	setChannelTopic(chann, topic = "") {
		return this.resolver.resolveChannel(chann)
		.then(channel =>
			request
			.patch(Endpoints.CHANNEL(channel.id))
			.set("authorization", this.token)
			.send({
				name: channel.name,
				position: channel.position,
				topic: topic
			})
			.end()
			.then(res => channel.topic = res.body.topic)
		);
	}

	//def setChannelName
	setChannelName(chann, name = "discordjs_is_the_best") {
		return this.resolver.resolveChannel(chann)
		.then(channel =>
			request
			.patch(Endpoints.CHANNEL(channel.id))
			.set("authorization", this.token)
			.send({
				name: name,
				position: channel.position,
				topic: channel.topic
			})
			.end()
			.then(res => channel.name = res.body.name)
		);
	}

	//def setChannelNameAndTopic
	setChannelNameAndTopic(chann, name = "discordjs_is_the_best", topic = "") {
		return this.resolver.resolveChannel(chann)
		.then(channel =>
			request
			.patch(Endpoints.CHANNEL(channel.id))
			.set("authorization", this.token)
			.send({
				name: name,
				position: channel.position,
				topic: topic
			})
			.end()
			.then(res => {
				channel.name = res.body.name;
				channel.topic = res.body.topic;
			})
		);
	}

	//def setTopic
	setChannelPosition(chann, position = 0) {
		return this.resolver.resolveChannel(chann)
		.then(channel =>
			request
			.patch(Endpoints.CHANNEL(channel.id))
			.set("authorization", this.token)
			.send({
				name: channel.name,
				position: position,
				topic: channel.topic
			})
			.end()
			.then(res => channel.position = res.body.position)
		);
	}

	//def updateChannel
	updateChannel(chann, data) {
		return this.setChannelNameAndTopic(chann, data.name, data.topic);
	}

	//def ack
	ack(msg) {
		msg = this.resolver.resolveMessage(msg);

		if(!msg) {
			Promise.reject(new Error("Message does not exist"));
		}

		return request
		.post(Endpoints.CHANNEL_MESSAGE(msg.channel.id, msg.id) + "/ack")
		.set("authorization", this.token)
		.end();
	}

	sendWS(object) {
		if (this.websocket) {
			this.websocket.send(JSON.stringify(object));
		}
	}

	createWS(url) {
		var self = this;
		var client = self.client;

		if (this.websocket) {
			return false;
		}

		this.websocket = new WebSocket(url);

		this.websocket.onopen = () => {

			self.sendWS({
				op: 2,
				d: {
					token: self.token,
					v: 3,
					compress: self.client.options.compress,
					properties: {
						"$os": "discord.js",
						"$browser": "discord.js",
						"$device": "discord.js",
						"$referrer": "discord.js",
						"$referring_domain": "discord.js"
					}
				}
			});
		};

		this.websocket.onclose = () => {
			self.websocket = null;
			self.state = ConnectionState.DISCONNECTED;
			self.disconnected();
		};

		this.websocket.onerror = e => {
			client.emit("error", e);
		};

		this.websocket.onmessage = e => {
			if (e.type === "Binary") {
				if (!zlib) zlib = require("zlib");
				e.data = zlib.inflateSync(e.data).toString();
			}

			var packet, data;
			try {
				packet = JSON.parse(e.data);
				data = packet.d;
			} catch (e) {
				client.emit("error", e);
				return;
			}

			client.emit("raw", packet);
			switch (packet.t) {

				case PacketType.READY:
					var startTime = Date.now();
					self.user = self.users.add(new User(data.user, client));
					data.guilds.forEach(server => {
						self.servers.add(new Server(server, client));
					});
					data.private_channels.forEach(pm => {
						self.private_channels.add(new PMChannel(pm, client));
					});
					self.state = ConnectionState.READY;

					self.intervals.kai = setInterval(() => self.sendWS({ op: 1, d: Date.now() }), data.heartbeat_interval);

					client.emit("ready");
					client.emit("debug", `ready packet took ${Date.now() - startTime}ms to process`);
					client.emit("debug", `ready with ${self.servers.length} servers, ${self.channels.length} channels and ${self.users.length} users cached.`);

					self.readyTime = Date.now();
					break;

				case PacketType.MESSAGE_CREATE:
					// format: https://discordapi.readthedocs.org/en/latest/reference/channels/messages.html#message-format
					var channel = self.channels.get("id", data.channel_id) || self.private_channels.get("id", data.channel_id);
					if (channel) {
						var msg = channel.messages.add(new Message(data, channel, client));

						if(self.messageAwaits[channel.id + msg.author.id]){
							self.messageAwaits[channel.id + msg.author.id].map( fn => fn(msg) );
							self.messageAwaits[channel.id + msg.author.id] = null;
							client.emit("message", msg, true); //2nd param is isAwaitedMessage
						}else{
							client.emit("message", msg);
						}
						self.ack(msg);
					} else {
						client.emit("warn", "message created but channel is not cached");
					}
					break;
				case PacketType.MESSAGE_DELETE:
					// format https://discordapi.readthedocs.org/en/latest/reference/channels/messages.html#message-delete
					var channel = self.channels.get("id", data.channel_id) || self.private_channels.get("id", data.channel_id);
					if (channel) {
						// potentially blank
						var msg = channel.messages.get("id", data.id);
						client.emit("messageDeleted", msg, channel);
						if (msg) {
							channel.messages.remove(msg);
						}
					} else {
						client.emit("warn", "message was deleted but channel is not cached");
					}
					break;
				case PacketType.MESSAGE_UPDATE:
					// format https://discordapi.readthedocs.org/en/latest/reference/channels/messages.html#message-format
					var channel = self.channels.get("id", data.channel_id) || self.private_channels.get("id", data.channel_id);
					if (channel) {
						// potentially blank
						var msg = channel.messages.get("id", data.id);


						if (msg) {
							// old message exists
							data.nonce = data.nonce || msg.nonce;
							data.attachments = data.attachments || msg.attachments;
							data.tts = data.tts || msg.tts;
							data.embeds = data.embeds || msg.embeds;
							data.timestamp = data.timestamp || msg.timestamp;
							data.mention_everyone = data.mention_everyone || msg.everyoneMentioned;
							data.content = data.content || msg.content;
							data.mentions = data.mentions || msg.mentions;
							data.author = data.author || msg.author;
							var nmsg = channel.messages.update(msg, new Message(data, channel, client));
							client.emit("messageUpdated", nmsg, msg);
						}
					} else {
						client.emit("warn", "message was updated but channel is not cached");
					}
					break;
				case PacketType.SERVER_CREATE:
					var server = self.servers.get("id", data.id);
					if (!server) {
						server = new Server(data, client)
						self.servers.add(server);
						client.emit("serverCreated", server);
					}
					break;
				case PacketType.SERVER_DELETE:
					var server = self.servers.get("id", data.id);
					if (server) {

						for (var channel of server.channels) {
							self.channels.remove(channel);
						}

						self.servers.remove(server);
						client.emit("serverDeleted", server);

					} else {
						client.emit("warn", "server was deleted but it was not in the cache");
					}
					break;
				case PacketType.SERVER_UPDATE:
					var server = self.servers.get("id", data.id);
					if (server) {
						// server exists
						data.members = data.members || [];
						data.channels = data.channels || [];
						var newserver = new Server(data, self);
						newserver.members = server.members;
						newserver.memberMap = server.memberMap;
						newserver.channels = server.channels;
						if (newserver.equalsStrict(server)) {
							// already the same don't do anything
							client.emit("debug", "received server update but server already updated");
						} else {
							self.servers.update(server, newserver);
							client.emit("serverUpdated", server, newserver);
						}
					} else if (!server) {
						client.emit("warn", "server was updated but it was not in the cache");
						self.servers.add(new Server(data, self));
						client.emit("serverCreated", server);
					}
					break;
				case PacketType.CHANNEL_CREATE:

					var channel = self.channels.get("id", data.id);

					if (!channel) {

						var server = self.servers.get("id", data.guild_id);
						if (server) {
							if (data.is_private) {
								client.emit("channelCreated", self.private_channels.add(new PMChannel(data, client)));
							} else {
								var chan = null;
								if (data.type === "text") {
									chan = self.channels.add(new TextChannel(data, client, server));
								} else {
									chan = self.channels.add(new VoiceChannel(data, client, server));
								}
								client.emit("channelCreated", server.channels.add(chan));
							}
						} else {
							client.emit("warn", "channel created but server does not exist");
						}

					} else {
						client.emit("warn", "channel created but already in cache");
					}

					break;
				case PacketType.CHANNEL_DELETE:
					var channel = self.channels.get("id", data.id);
					if (channel) {

						if (channel.server) // accounts for PMs
							channel.server.channels.remove(channel);

						self.channels.remove(channel);
						client.emit("channelDeleted", channel);

					} else {
						client.emit("warn", "channel deleted but already out of cache?");
					}
					break;
				case PacketType.CHANNEL_UPDATE:
					var channel = self.channels.get("id", data.id) || self.private_channels.get("id", data.id);
					if (channel) {

						if (channel instanceof PMChannel) {
							//PM CHANNEL
							client.emit("channelUpdated", channel, self.private_channels.update(
								channel,
								new PMChannel(data, client)
								));
						} else {
							if (channel.server) {
								if (channel.type === "text") {
									//TEXT CHANNEL
									var chan = new TextChannel(data, client, channel.server);
									chan.messages = channel.messages;
									channel.server.channels.update(channel, chan);
									self.channels.update(channel, chan);
									client.emit("channelUpdated", channel, chan);
								} else {
									//VOICE CHANNEL
									var chan = new VoiceChannel(data, client, channel.server);
									channel.server.channels.update(channel, chan);
									self.channels.update(channel, chan);
									client.emit("channelUpdated", channel, chan);
								}
							} else {
								client.emit("warn", "channel updated but server non-existant");
							}
						}

					} else {
						client.emit("warn", "channel updated but not in cache");
					}
					break;
				case PacketType.SERVER_ROLE_CREATE:
					var server = self.servers.get("id", data.guild_id);
					if (server) {
						client.emit("serverRoleCreated", server.roles.add(new Role(data.role, server, client)), server);
					} else {
						client.emit("warn", "server role made but server not in cache");
					}
					break;
				case PacketType.SERVER_ROLE_DELETE:
					var server = self.servers.get("id", data.guild_id);
					if (server) {
						var role = server.roles.get("id", data.role_id);
						if (role) {
							server.roles.remove(role);
							client.emit("serverRoleDeleted", role);
						} else {
							client.emit("warn", "server role deleted but role not in cache");
						}
					} else {
						client.emit("warn", "server role deleted but server not in cache");
					}
					break;
				case PacketType.SERVER_ROLE_UPDATE:
					var server = self.servers.get("id", data.guild_id);
					if (server) {
						var role = server.roles.get("id", data.role.id);
						if (role) {
							var newRole = new Role(data.role, server, client);
							server.roles.update(role, newRole);
							client.emit("serverRoleUpdated", role, newRole);
						} else {
							client.emit("warn", "server role updated but role not in cache");
						}
					} else {
						client.emit("warn", "server role updated but server not in cache");
					}
					break;
				case PacketType.SERVER_MEMBER_ADD:
					var server = self.servers.get("id", data.guild_id);
					if (server) {

						server.memberMap[data.user.id] = {
							roles: data.roles.map(pid => server.roles.get("id", pid)),
							mute: false,
							deaf: false,
							joinedAt: Date.parse(data.joined_at)
						};

						client.emit(
							"serverNewMember",
							server,
							server.members.add(self.users.add(new User(data.user, client)))
							);

					} else {
						client.emit("warn", "server member added but server doesn't exist in cache");
					}
					break;
				case PacketType.SERVER_MEMBER_REMOVE:
					var server = self.servers.get("id", data.guild_id);
					if (server) {
						var user = self.users.get("id", data.user.id);
						if (user) {
							server.memberMap[data.user.id] = null;
							server.members.remove(user);
							client.emit("serverMemberRemoved", server, user);
						} else {
							client.emit("warn", "server member removed but user doesn't exist in cache");
						}
					} else {
						client.emit("warn", "server member removed but server doesn't exist in cache");
					}
					break;
				case PacketType.SERVER_MEMBER_UPDATE:
					var server = self.servers.get("id", data.guild_id);
					if (server) {
						var user = self.users.get("id", data.user.id);
						if (user) {
							server.memberMap[data.user.id].roles = data.roles.map(pid => server.roles.get("id", pid));
							server.memberMap[data.user.id].mute = data.mute;
							server.memberMap[data.user.id].deaf = data.deaf;
							client.emit("serverMemberUpdated", server, user);
						} else {
							client.emit("warn", "server member removed but user doesn't exist in cache");
						}
					} else {
						client.emit("warn", "server member updated but server doesn't exist in cache");
					}
					break;
				case PacketType.PRESENCE_UPDATE:

					var user = self.users.get("id", data.user.id);

					if (user) {

						data.user.username = data.user.username || user.username;
						data.user.id = data.user.id || user.id;
						data.user.avatar = data.user.avatar || user.avatar;
						data.user.discriminator = data.user.discriminator || user.discriminator;

						var presenceUser = new User(data.user, client);

						if (presenceUser.equals(user)) {
							// a real presence update
							client.emit("presence", user, data.status, data.game_id);
							user.status = data.status;
							user.gameID = data.game_id;

						} else {
							// a name change or avatar change
							client.emit("userUpdated", user, presenceUser);
							self.users.update(user, presenceUser);
						}

					} else {
						client.emit("warn", "presence update but user not in cache");
					}

					break;
				case PacketType.TYPING:

					var user = self.users.get("id", data.user_id);
					var channel = self.channels.get("id", data.channel_id) || self.private_channels.get("id", data.channel_id);

					if (user && channel) {
						if (user.typing.since) {
							user.typing.since = Date.now();
							user.typing.channel = channel;
						} else {
							user.typing.since = Date.now();
							user.typing.channel = channel;
							client.emit("userTypingStarted", user, channel);
						}
						setTimeout(() => {
							if (Date.now() - user.typing.since > 5500) {
								// they haven't typed since
								user.typing.since = null;
								user.typing.channel = null;
								client.emit("userTypingStopped", user, channel);
							}
						}, 6000);

					} else {
						client.emit("warn", "user typing but user or channel not existant in cache");
					}
					break;
				case PacketType.SERVER_BAN_ADD:
					var user = self.users.get("id", data.user.id);
					var server = self.servers.get("id", data.guild_id);

					if (user && server) {
						client.emit("userBanned", user, server);
					} else {
						client.emit("warn", "user banned but user/server not in cache.");
					}
					break;
				case PacketType.SERVER_BAN_REMOVE:
					var user = self.users.get("id", data.user.id);
					var server = self.servers.get("id", data.guild_id);

					if (user && server) {
						client.emit("userUnbanned", user, server);
					} else {
						client.emit("warn", "user unbanned but user/server not in cache.");
					}
					break;
			}
		};
	}
}
