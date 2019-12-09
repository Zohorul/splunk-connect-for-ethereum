import { Address } from './msgs';
import { EthereumClient } from './eth/client';
import { getCode } from './eth/requests';
import { sha3 } from 'web3-utils';
import { createModuleDebug } from './utils/debug';

const { debug } = createModuleDebug('contract');

export interface ContractInfo {
    /** True if the corresponding account is a smart contract, otherwise false */
    isContract: boolean;
    /** A unqiue representation of all function and event signatures of a contract */
    fingerprint?: string;
    /** Name of the contract from configured ABIs */
    contractName?: string;
}

export type SignatureMatcher = (sig: string, address?: Address) => string | undefined;
export type ContractNameLookup = (address: Address, fingerprint: string) => string | undefined;

/**
 * Find function and event signature hashes in the EVM bytecode and attempt to match them against
 * known hashes from configured ABIs
 */
export function extractFunctionsAndEvents(
    contractCode: string,
    signatureMatcher: SignatureMatcher
): { functions: string[]; events: string[] } | undefined {
    const functionMatches: Set<string> = new Set();
    const eventMatches: Set<string> = new Set();
    const code = Buffer.from(contractCode.slice(2), 'hex');
    for (let i = 0, len = code.length; i < len; i++) {
        const opcode = code[i];
        // Look for PUSH<n> opcodes - their pushData may contain a log topic or function signature hash
        if (opcode >= 0x60 && opcode <= 0x7f) {
            const dataLength = opcode - 0x5f;
            if (dataLength === 32 || dataLength === 4) {
                const data = code.slice(i + 1, i + dataLength + 1).toString('hex');
                const match = signatureMatcher(data);
                if (match) {
                    (dataLength === 4 ? functionMatches : eventMatches).add(match);
                }
            }
            i += dataLength;
        }
    }

    const functions = [...functionMatches].sort();
    const events = [...eventMatches].sort();
    return { functions, events };
}

/** Creates a hash of all function and event signatures of a contract used to match ABIs against EVM bytecode */
export function computeContractFingerprint(
    { functions, events }: { functions: string[]; events: string[] } = { functions: [], events: [] }
): string | undefined {
    if (functions.length === 0 && events.length === 0) {
        return;
    }
    const fingerprint = sha3(`${functions.join(',')}|${events.join(',')}`).slice(2); // TODO hash
    return fingerprint;
}

/**
 * Attempts to determine if the given account address is a smart contract and
 * determines some additional information if that's the case
 */
export async function getContractInfo(
    address: Address,
    ethClient: EthereumClient,
    signatureMatcher?: SignatureMatcher,
    contractNameLookup?: ContractNameLookup
): Promise<ContractInfo> {
    debug('Retrieving contract information for address %s', address);
    const code = await ethClient.request(getCode(address));
    if (code === '0x') {
        return { isContract: false };
    }
    if (signatureMatcher == null) {
        return { isContract: true };
    }
    const fingerprint = computeContractFingerprint(
        extractFunctionsAndEvents(code, (fingerprint: string) => signatureMatcher(fingerprint, address))
    );
    const contractName =
        fingerprint != null && contractNameLookup != null ? contractNameLookup(address, fingerprint) : undefined;
    return {
        isContract: true,
        fingerprint,
        contractName,
    };
}
