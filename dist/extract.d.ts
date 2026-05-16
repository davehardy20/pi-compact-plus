import type { AgentMessage } from "@earendil-works/pi-agent-core";
/**
 * Text extraction and low-level content analysis helpers.
 * These are the foundational building blocks used by snapshot and classify.
 */
export declare function extractTextContent(msg: AgentMessage): string;
export declare function isConversationalFiller(text: string): boolean;
export declare function extractObjective(allMessages: AgentMessage[]): string;
export declare function findExplicitObjective(messages: AgentMessage[]): string | undefined;
export declare function findSubstantialObjective(messages: AgentMessage[]): string | undefined;
export declare function extractActiveFiles(messages: AgentMessage[]): string[];
export declare function extractBlockers(messages: AgentMessage[]): string[];
export declare function extractDecisions(messages: AgentMessage[]): string[];
export declare function extractNextStep(messages: AgentMessage[]): string;
export declare function extractDependencyChain(messages: AgentMessage[], knownDecisions: string[]): string[];
