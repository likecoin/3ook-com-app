const { withInfoPlist } = require('@expo/config-plugins');

const { APP_BOUND_DOMAINS } = require('../services/app-bound-domains');

module.exports = function withAppBoundDomains(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.WKAppBoundDomains = APP_BOUND_DOMAINS;
    return config;
  });
};
