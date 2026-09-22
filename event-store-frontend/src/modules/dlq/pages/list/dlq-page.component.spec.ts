import { provideHttpClient } from "@angular/common/http";
import { provideHttpClientTesting } from "@angular/common/http/testing";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, convertToParamMap, Router } from "@angular/router";
import { TranslateModule } from "@ngx-translate/core";
import type { DlqListResponse } from "@models/dlq.model";
import { DlqService } from "@services/implementations/dlq.service";
import { of } from "rxjs";

import { DlqPageComponent } from "./dlq-page.component";

describe("DlqPageComponent", () => {
  let component: DlqPageComponent;
  let fixture: ComponentFixture<DlqPageComponent>;
  let dlqService: jasmine.SpyObj<DlqService>;
  let router: jasmine.SpyObj<Router>;

  const emptyList: DlqListResponse = { data: [], total: 0 };

  beforeEach(async () => {
    dlqService = jasmine.createSpyObj<DlqService>("DlqService", [
      "list",
      "listSinks",
    ]);
    dlqService.list.and.returnValue(of(emptyList));
    dlqService.listSinks.and.returnValue(of(["messenger_service.calls"]));
    router = jasmine.createSpyObj<Router>("Router", ["navigate"]);
    router.navigate.and.returnValue(Promise.resolve(true));

    await TestBed.configureTestingModule({
      imports: [DlqPageComponent, TranslateModule.forRoot()],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DlqService, useValue: dlqService },
        { provide: Router, useValue: router },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DlqPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create and load the initial DLQ list", () => {
    expect(component).toBeTruthy();
    expect(dlqService.list).toHaveBeenCalled();
    expect(component.total()).toBe(0);
  });

  it("offers the sinks the API reports, not a hard-coded list", () => {
    expect(dlqService.listSinks).toHaveBeenCalled();
    expect(component.sinkOptions()).toEqual(["messenger_service.calls"]);
  });

  it("openDetail navigates to the record detail route", () => {
    const record = {
      id: "11111111-1111-4111-8111-111111111111",
      subject: "events.dlq.test",
      sink: "test",
      originalSubject: "events.test",
      ownerId: null,
      correlationId: null,
      lastError: "err",
      failedAt: "2026-01-01T00:00:00.000Z",
      payload: {},
      envelope: null,
      ingestedAt: "2026-01-01T00:00:00.000Z",
      replayedAt: null,
      jetstreamStream: "DLQ",
      jetstreamSequence: "1",
    };

    component.openDetail(record);
    expect(router.navigate).toHaveBeenCalledWith([record.id], {
      relativeTo: jasmine.any(Object),
      queryParamsHandling: "preserve",
    });
  });
});
