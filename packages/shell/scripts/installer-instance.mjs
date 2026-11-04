// Installer instance is explicit: an absent CI dispatch input means production.
export function resolveInstallerInstance(value = "prod") {
  if (value !== "prod" && value !== "dev") throw new Error(`Invalid installer instance: ${value}`);
  const dev = value === "dev";
  return {
    instance: value,
    productName: dev ? "Naia-dev" : "Naia",
    env: {
      VITE_NAIA_USE_DEV_GATEWAY: dev ? "1" : "0",
      VITE_NAIA_WEB_BASE_URL: dev ? "https://dev.naia.land" : "https://www.naia.land",
      VITE_NAIA_DEV_GATEWAY_URL: dev ? "https://api-dev.naia.land" : "",
    },
  };
}

export function installerInstanceConf(base, instance) {
  if (instance.instance === "prod") return {};
  return {
    productName: instance.productName,
    app: { windows: base.app.windows.map(window => ({ ...window, title: instance.productName })) },
  };
}
