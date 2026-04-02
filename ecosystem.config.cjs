module.exports = {
  apps: [{
    name: "prospera",
    script: "index.js",
    instances: 1,
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: "10s",
    watch: false,
    env: {
      NODE_ENV: "production",
    },
  }],
};
