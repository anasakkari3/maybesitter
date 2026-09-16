import { registerRootComponent } from 'expo';
import { registerWidgetTaskHandler } from 'react-native-android-widget';

import App from './App';
import { defineNotificationResponseTask } from './src/features/reminders/tapEffects';
import { widgetTaskHandler } from './src/features/widget/android/widgetTaskHandler';

// Before the app registers: Android runs this task for a Done or Later pressed
// while the app is killed, with no React tree (UC-3.14, #200).
defineNotificationResponseTask();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// The Android home-screen widget's renderer (UC-3.R1, #203). The launcher wakes
// it as a headless task, so it has to be registered here, at bundle load,
// rather than from inside the React tree. It is a no-op on iOS, whose widget is
// the WidgetKit extension in `targets/widget/`.
registerWidgetTaskHandler(widgetTaskHandler);
