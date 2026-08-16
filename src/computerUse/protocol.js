import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('computerUse/protocol.js');

export const {
    COMPUTER_USE_ACTION_NAMES,
    COMPUTER_USE_DESKTOP_ACTION_NAMES,
    COMPUTER_USE_WINDOW_ACTION_NAMES,
    MAX_COMPUTER_USE_STEP_ACTIONS,
    MAX_COMPUTER_USE_TYPE_CHARACTERS,
    MAX_COMPUTER_USE_KEYPRESS_KEYS,
    ComputerUseError,
    createComputerUseError,
    isComputerUseError,
    isNormalizedComputerUseCoordinateSpace,
    isComputerUseTextInputAction,
    hasComputerUseCoordinates,
    hasUnsafeComputerUsePointerInputBatch,
    isSupportedComputerUseKeyName,
    validateComputerUseAction,
    validateComputerUseStepActions,
} = implementation;
