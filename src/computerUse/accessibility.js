import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('computerUse/accessibility.js');

export const { AccessibilitySnapshotService } = implementation;
