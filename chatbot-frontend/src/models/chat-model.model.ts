export interface ChatModelOptionDto {
  readonly id: string;
  readonly display_name: string;
}

export interface ChatModelsResponseDto {
  readonly models: readonly ChatModelOptionDto[];
  readonly default_model: string;
}
