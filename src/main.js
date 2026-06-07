#!/usr/bin/env -S gjs -m

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';

import { CuscoApplication } from './application.js';

Adw.init();

const application = new CuscoApplication();
const programName = GLib.get_prgname() ?? 'cusco';

application.run([programName, ...ARGV]);
