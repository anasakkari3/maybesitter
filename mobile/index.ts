import { registerRootComponent } from 'expo';

import App from './App';
import { defineNotificationResponseTask } from './src/features/reminders/tapEffects';

// Before the app registers: Android runs this task for a Done or Later pressed
// while the app is killed, with no React tree (UC-3.14, #200).
defineNotificationResponseTask();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
