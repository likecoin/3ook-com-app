import PostHog from 'posthog-react-native';

export const posthog = new PostHog(
  'phc_VOXrU28p44Z0coehNjKThwVPK5dO0A6xwQTQqThWI1c',
  {
    host: 'https://us.i.posthog.com',
    captureAppLifecycleEvents: true,
  }
);
