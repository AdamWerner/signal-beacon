import { signals } from "@/data/mockData";

export const useSignals = () => {
  return { data: signals, isLoading: false };
};
