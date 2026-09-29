import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('computerUse/manager.js');

export const {
    COMPUTER_USE_MODE_BACKGROUND,
    COMPUTER_USE_MODE_CURRENT_DESKTOP,
    normalizeComputerUseMode,
    ComputerUseManager,
} = implementation;
