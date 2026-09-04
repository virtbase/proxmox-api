import { expect, test } from "bun:test";
import proxmoxApi from "../index.js";

type DummyType = typeof fetch & {
  url: string;
  responseData: unknown;
  options?: RequestInit;
};

function dumyFetch(responseData: unknown): DummyType {
  const dumy: DummyType = ((url: string | URL, options?: RequestInit) => {
    dumy.url = url.toString();
    dumy.options = options;
    let text = "";
    const status = 200;
    const headers = new Headers({
      "content-type": "application/json;charset=UTF-8",
    });

    if (url === "https://127.0.0.1/api2/json/access/ticket") {
      text = JSON.stringify({
        data: { ticket: "1234", CSRFPreventionToken: "1234" },
      });
    } else {
      text = JSON.stringify(dumy.responseData);
    }
    //    return Promise.resolve({ data: { ticket: '1234' } });
    const response = {
      text: () => Promise.resolve(text),
      status,
      headers,
    } as any;
    // console.log('fetch', url, options);
    return Promise.resolve(response);
  }) as DummyType;
  dumy.responseData = responseData;

  return dumy as DummyType;
}

test("encodes query and body parameters the way the PVE API expects", async () => {
  const myfetch: any = dumyFetch({ data: {}, errors: undefined });
  const proxmox = proxmoxApi({
    host: "127.0.0.1",
    password: "password",
    username: "user1@pam",
    fetch: myfetch,
  });
  const theNode = proxmox.nodes.$("node1");

  // `true` is encoded as 1.
  await theNode.qemu.$get({ full: true });
  expect(myfetch.url).toBe(
    "https://127.0.0.1/api2/json/nodes/node1/qemu?full=1",
  );

  const qemu = theNode.qemu.$(100);
  const post = qemu.agent.exec.$post;
  await post({ command: ["touch", "/test"] });
  expect(myfetch.url).toBe(
    "https://127.0.0.1/api2/json/nodes/node1/qemu/100/agent/exec",
  );
  // An array parameter is passed as repeated values.
  // old: "command=touch%2C%2Ftest"
  // new: "command=touch&command=%2Ftest"
  expect(myfetch.options.body).toBe("command=touch&command=%2Ftest");
});
