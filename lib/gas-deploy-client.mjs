export class DeploymentStateUncertainError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'DeploymentStateUncertainError';
    this.state = 'uncertain';
    this.readbackRequired = true;
  }
}

export function stateUncertainAfterMutation(error) {
  return new DeploymentStateUncertainError(
    'deployment state is uncertain after the self-deploy mutation request; authoritative readback required',
    error
  );
}
