import { prepareLegacyWorkbook } from "./legacy-excel-layout";
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = await prepareLegacyWorkbook(event.data);
    (self as unknown as Worker).postMessage({ result }, [result.workbook]);
  } catch (error) { self.postMessage({ error: String(error) }); }
};
