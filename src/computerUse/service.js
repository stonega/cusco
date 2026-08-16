import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('computerUse/service.js');

export const {
    COMPUTER_USE_BUS_NAME,
    COMPUTER_USE_OBJECT_PATH,
    COMPUTER_USE_INTERFACE,
    COMPUTER_USE_EXTENSION_UUID,
    COMPUTER_USE_PROTOCOL_VERSION,
    COMPUTER_USE_AGENT_PROTOCOL_VERSION,
    evaluateComputerUseExpectations,
    ComputerUseService,
} = implementation;
