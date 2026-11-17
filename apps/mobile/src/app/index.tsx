import { HomeScreen } from '../screens/HomeScreen'

// Route files only wire screens: tests and components live outside src/app, where every file is a route.
export default function Index() {
  return <HomeScreen />
}
