import React from "react";

interface ParamsPanelProps {
  params: Record<string, string>;
  onParamsChange: (params: Record<string, string>) => void;
}

const ParamsPanel: React.FC<ParamsPanelProps> = ({ params, onParamsChange }) => {
  const paramName = "paramName";
  const handleParamChange = (key: string, value: string) => {
    onParamsChange({
      ...params,
      [key]: value
    });
  };

  const handleAddParam = () => {
    const newKey = `param${Object.keys(params).length + 1}`;
    onParamsChange({
      ...params,
      [newKey]: ""
    });
  };

  const handleRemoveParam = (key: string) => {
    const newParams = { ...params };
    delete newParams[key];
    onParamsChange(newParams);
  };

  return (
    <div className="w-64 border-l border-border bg-muted p-4 overflow-y-auto">
      <h3 className="text-sm font-medium text-foreground mb-4">Notebook Parameters</h3>
      <div className="space-y-3">
        {Object.entries(params).map(([key, value]) => (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between">
              <input
                type="text"
                value={key}
                onChange={(e) => {
                  const newKey = e.target.value;
                  if (newKey && newKey !== key) {
                    const newParams = { ...params };
                    const paramValue = newParams[key] || "";
                    delete newParams[key];
                    newParams[newKey] = paramValue;
                    onParamsChange(newParams);
                  }
                }}
                className="bg-background text-foreground px-2 py-1 rounded text-sm w-full focus:outline-none focus:ring-1 focus:ring-ring border border-border"
              />
              <button
                onClick={() => handleRemoveParam(key)}
                className="ml-2 p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
                title="Remove parameter"
              >
                ×
              </button>
            </div>
            <input
              type="text"
              value={value}
              onChange={(e) => handleParamChange(key, e.target.value)}
              className="bg-background text-foreground px-2 py-1 rounded text-sm w-full focus:outline-none focus:ring-1 focus:ring-ring border border-border"
              placeholder="Parameter value"
            />
          </div>
        ))}
        <button
          onClick={handleAddParam}
          className="w-full flex items-center justify-center space-x-2 bg-card hover:bg-accent text-foreground px-3 py-2 rounded-md border border-border transition-colors text-sm"
        >
          <span>+</span>
          <span>Add Parameter</span>
        </button>
      </div>
      <div className="mt-4 text-xs text-muted-foreground">
        <p>Use parameters in SQL cells with <code className="bg-background px-1 rounded">{paramName}</code></p>
      </div>
    </div>
  );
};

export default ParamsPanel;