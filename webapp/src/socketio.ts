'use strict';

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { client } from './redis';
import debug from 'debug';
const log = debug('webapp:socket');

import { ObjectId } from 'mongodb';
import { addChatMessage, unsafeGetTeamJsonMessage, getAgentMessageForSession } from './db/chat';
import { AgentType, addAgents } from './db/agent';
import { addSession, unsafeGetSessionById, unsafeSetSessionAgents, unsafeSetSessionStatus,
	SessionType, SessionStatus, unsafeSetSessionUpdatedDate } from './db/session';

import useJWT from './lib/middleware/auth/usejwt';
import useSession from './lib/middleware/auth/usesession';
import fetchSession from './lib/middleware/auth/fetchsession';
import checkSession from './lib/middleware/auth/checksession';
const socketMiddlewareChain  = [useSession, useJWT, fetchSession, checkSession];

export function initSocket(rawHttpServer) {

	const io = new Server();
	io.attach(rawHttpServer);
	const pubClient = client.duplicate();
	const subClient = client.duplicate();

	io.adapter(createAdapter(pubClient, subClient));

	io.use((socket, next) => {
		useSession(socket.request, socket.request, next);
	});
	io.use((socket, next) => {
		useJWT(socket.request, socket.request, next);
	});
	io.use((socket, next) => {
		fetchSession(socket.request, socket.request, next);
	});

	//NOTE: there is almost no security/validation here, yet
	io.on('connection', async (socket) => {
		log('Socket %s connected', socket.id);

		socket.onAny((eventName, ...args) => {
			log('Received socket event %s args: %O', eventName, args);
		});

		socket.on('join_room', async (room: string) => {
			//TODO: permission check for joining rooms
			socket.join(room);
			const socketRequest = socket.request as any;
			log('Socket %s joined room %s', socket.id, room);
			if (socketRequest?.session?.token) {
				//if it has auth (only webapp atm), send back joined message
				socket.emit('joined', room);
				log('Emitting join message back to %s in room %s', socket.id, room);
				const session = await unsafeGetSessionById(room);
				if (!session || session.status === SessionStatus.STARTED) {
					return;
				}
				const fromPythonMessage = await getAgentMessageForSession(room);
				if (fromPythonMessage) {
					return;
				}
				//await unsafeSetSessionStatus(room, SessionStatus.STARTED); //NOTE: may race
				io.to('task_queue').emit(SessionType.TEAM, {
					task: session.prompt,
					sessionId: room,
				});
			}
		});

		socket.on('terminate', async (data) => {
			//TODO: ensure only sent by python app
			const session = await unsafeGetSessionById(data.message.sessionId);
			if (session.agents && session.agents.length > 0) {
				await unsafeSetSessionStatus(data.message.sessionId, SessionStatus.TERMINATED);
				return io.to(data.room).emit('terminate', true);
			}
			const sessionTeamJsonMessage = await unsafeGetTeamJsonMessage(data.message.sessionId);
			const generatedRoles = sessionTeamJsonMessage?.message?.message?.text?.roles;
			if (!generatedRoles) {
				return console.warn('No generated roles found for terminated session', data.message.sessionId);
			}
			const mappedRolesToAgents = generatedRoles.map(role => ({ //TODO: type these
				_id: new ObjectId(),
				sessionId: session._id,
				orgId: session.orgId,
				teamId: session.teamId,
				name: role.name,
				type: role.type as AgentType,
				llmConfig: role.llm_config,
				codeExecutionConfig: role.code_execution_config
					? {
						lastNMessages: role.code_execution_config.last_n_messages,
						workDirectory: role.code_execution_config.work_dir
					}
					: null,
				isUserProxy: role.is_user_proxy || false,
				systemMessage: role.system_message,
				humanInputMode: role.human_input_mode,
			}));
			await addAgents(mappedRolesToAgents); //TODO: pass teamId
			const sessionAgents = mappedRolesToAgents.map(agent => ({
				agentId: agent._id,
				reportTo: null, //unused atm
			}));
			await unsafeSetSessionAgents(session._id, sessionAgents, sessionTeamJsonMessage?.message?.message?.text);
			io.to(data.room).emit('type', SessionType.TASK);
			io.to('task_queue').emit(SessionType.TASK, {
				task: session.prompt,
				sessionId: session._id.toString(),
			});
		});

		socket.on('message', async (data) => {
		
			const socketRequest = socket.request as any;
			data.event = data.event || 'message';
			const messageTimestamp = data?.message?.timestamp || Date.now();
			if (typeof data.message !== 'object') {
				data.message = {
					type: 'text',
					text: data.message,
				};
			}

			let message;
			switch(data.message.type) {
				case 'code':
					if (data.message.language === 'json'
						|| (typeof data.message.text === 'string'
							&& data.message.text.startsWith('{'))) { //monkey patch
						data.message.text = JSON.parse(data.message.text);
						data.message.language = 'json';
					}
					message = data.message;
					break;
				default:
					message = data.message; //any processing?
					break;
			}

			let finalMessage = message;
			if (data.room !== 'task_queue') {
				finalMessage = {
					...data,
					incoming: data.incoming != null ? data.incoming : false,
					authorName: data.authorName || 'System',
					message: finalMessage,
					ts: messageTimestamp,
				};
			}

			if (finalMessage.room && finalMessage.room.length === 24) {
				//TODO: change to normal getsessionbyid, but then the python thing would need to be authed as a special user.
				const session = await unsafeGetSessionById(finalMessage.room);
				await unsafeSetSessionUpdatedDate(finalMessage.room);
				await addChatMessage({
					orgId: session.orgId,
					teamId: session.teamId,
					sessionId: session._id,
					message: finalMessage,
					type: session.type as SessionType,
					authorId: finalMessage.authorId || socketRequest?.session?.account?._id || null, //TODO: fix for socket user id
					authorName: finalMessage.authorName || socketRequest?.session?.account?.name || 'AgentCloud',  //TODO: fix for socket user name
					ts: finalMessage.ts || messageTimestamp,
					isFeedback: finalMessage?.isFeedback || false,
				});
				const newStatus = finalMessage?.isFeedback ? SessionStatus.WAITING : SessionStatus.RUNNING;
				if (newStatus !== session.status) { //Note: chat messages can be received out of order
					log('updating session status to %s', newStatus);
					await unsafeSetSessionStatus(session._id, newStatus);
					io.to(data.room).emit('status', newStatus);
				}
			}

			io.to(data.room).emit(data.event, finalMessage);
			if (data.room !== 'task_queue' && finalMessage.message && (finalMessage.incoming === true || socketRequest?.session?.account?._id)) {
				log('Relaying message %O to private room %s', finalMessage, `_${data.room}`);
				io.to(`_${data.room}`).emit(data.event, finalMessage.message.text);
			}

		});

	});

}
