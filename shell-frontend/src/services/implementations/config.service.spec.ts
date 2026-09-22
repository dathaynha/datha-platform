import { TestBed } from "@angular/core/testing";
import { of } from "rxjs";
import { EnvService } from "./config.service";

describe("EnvService", () => {
  let service: EnvService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [EnvService],
    });
    service = TestBed.inject(EnvService);
    spyOn(service, "getProxyEnvs").and.returnValue(of({}));
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });
});
