import type * as React from 'react';

type Handler = (...args: unknown[]) => void;

export interface MessageInfo {
  id: string;
  nick: string;
  text: string;
  raw: string;
  kind: string;
  ts: number;
  mine: boolean;
  buffer?: string;
  tags?: Record<string, string>;
}

export interface OrbitPluginApi {
  name: string;
  version: string;
  commit: string;
  apiVersion: number;
  React: typeof React;
  on(event: string, fn: Handler): () => void;
  once(event: string, fn: Handler): () => void;
  off(event: string, fn: Handler): void;
  emit(event: string, ...args: unknown[]): void;
  state: {
    active(): string;
    nick(): string;
    account(): string;
    buffers(): string[];
    get(): {
      buffers: Record<string, { name: string; isChannel: boolean; members?: Record<string, { prefix?: string; prefixes?: string }> }>;
      client: null;
      [k: string]: unknown;
    };
  };
  server: {
    network(): string;
    hasCap(cap: string): boolean;
  };
  irc: {
    send(line: string): void;
    msg(target: string, text: string): void;
    msgTagged(target: string, text: string, tags: Record<string, string>): void;
    say(text: string): void;
  };
  config(): { conference?: ConferenceConfig; [k: string]: unknown };
  storage: { get<T>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void };
  addUi(slot: string, render: () => React.ReactNode): () => void;
  addMessageDecorator(render: (m: MessageInfo) => React.ReactNode): () => void;
  i18n: { pick(table: Record<string, string>): string };
  log(...args: unknown[]): void;
}

export interface ConferenceConfig {
  server?: string;
  secure?: boolean;
  tagID?: string;
  channels?: boolean;
  queries?: boolean;
  enabledInChannels?: string[];
  viewHeight?: string;
  inviteText?: string;
  joinText?: string;
  joinButtonText?: string;
}

declare global {
  const Orbit: {
    version: string;
    apiVersion: number;
    React: typeof React;
    plugin(name: string, fn: (orbit: OrbitPluginApi, log: Handler) => void): void;
  };
}

export {};
