'use strict';

import * as db from 'db/index';
import toObjectId from 'misc/toobjectid';
import { ObjectId } from 'mongodb';
import { InsertResult } from 'struct/db';

export type ChatChunk = {
	ts: number;
	chunk: string;
	tokens: number; //might remove
}

export type ChatCodeBlock = {
	language: string;
	codeBlock: string;
}

export type DisplayType = 'bubble' | 'inline';

export type ChatMessage = {
	_id?: ObjectId;
	orgId: ObjectId;
	teamId: ObjectId;
	sessionId: ObjectId;
	chunkId?: string;
	message: any;
	ts: number;
	authorId: ObjectId;
	isFeedback: boolean;
	displayType: DisplayType;
	authorName: string;
	tokens?: number;
	chunks?: ChatChunk[];
	codeBlocks?: ChatCodeBlock[];
	completed?: boolean;
}

export function ChatCollection(): any {
	return db.db().collection('chat');
}

export function getChatMessageById(teamId: db.IdOrStr, messageId: db.IdOrStr): Promise<ChatMessage> {
	return ChatCollection().findOne({
		_id: toObjectId(messageId),
		teamId: toObjectId(teamId),
	});
}

export function getChatMessagesBySession(teamId: db.IdOrStr, sessionId: db.IdOrStr): Promise<ChatMessage[]> {
	return ChatCollection().find({
		sessionId: toObjectId(sessionId),
		teamId: toObjectId(teamId),
	}).toArray();
}

export function getAgentMessageForSession(sessionId: db.IdOrStr): Promise<ChatMessage> {
	return ChatCollection().findOne({
		sessionId: toObjectId(sessionId),
		'message.incoming': false,
	});
}

export function unsafeGetTeamJsonMessage(sessionId: db.IdOrStr): Promise<ChatMessage|null> {
	return ChatCollection().find({
		sessionId: toObjectId(sessionId),
		'codeBlocks.language': 'json',
	}).sort({
		_id: -1,
	}).limit(1).toArray().then(res => res && res.length > 0 ? res[0] : null);
}

// Revised function that handles both upserting and updating chat messages
export async function upsertOrUpdateChatMessage(sessionId: db.IdOrStr, chatMessage: Partial<ChatMessage>, chunk: ChatChunk) {
	return ChatCollection().updateOne({
		sessionId: toObjectId(sessionId),
		chunkId: chatMessage.chunkId,
		completed: { $ne: true } //this may be a mistake
	}, {
		$setOnInsert: chatMessage,
		...(chunk ? {
			$push: { chunks: chunk }, // Push new chunk if provided
			$inc: { tokens: chunk.tokens || 0 }, // Increment token count
		} : {}),
	}, { upsert: true });
}

export async function updateCompletedMessage(sessionId: db.IdOrStr, chunkId: string, text: string, codeBlocks: ChatCodeBlock, tokens: number) {
	const update = {
		$unset: {
			chunks: '',
		},
		$set: {
			'message.message.text': text,
			completed: true,
			codeBlocks,
		},
		$inc: {
			tokens: tokens || 0,
		}
	};
	return ChatCollection().updateOne({
		sessionId: toObjectId(sessionId),
		chunkId,
	}, update);
}

export async function addChatMessage(chatMessage: ChatMessage): Promise<InsertResult> {
	return ChatCollection().insertOne(chatMessage);
}

export function getLatestChatMessage(sessionId: db.IdOrStr): Promise<ChatMessage|null> {
	return ChatCollection().findOne({
		sessionId: toObjectId(sessionId),
	}, null, {
		sort: {
			ts: -1, //TODO: revise ts
		}
	});
}
